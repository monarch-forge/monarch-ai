/**
 * pi engine: pi-agent-core `Agent` over the shared pi-ai `Models` collection (any provider).
 *
 * One Agent per session is kept in memory. Its transcript (pi's own AgentMessage[] minus system
 * messages) is persisted in the session file after every turn (`engineState.piMessages`) and used to
 * rebuild the Agent after a restart, so tool calls/results and thinking survive exactly.
 * The system prompt is set when the Agent is (re)built and then kept stable for prompt caching.
 * Auth: resolved by pi-ai through our secrets-backed CredentialStore (OAuth → stored key → env),
 * see pi-models.ts — no `getApiKey` hook needed.
 */
import { z } from 'zod';
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { clampThinkingLevel, cleanupSessionResources, type Api, type Model, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { Usage } from '@monarch/shared';
import { defineTool, truncate, type ToolDef } from '../../kernel.ts';
import { getSettings } from '../../settings.ts';
import { emptyUsage, addUsage, autoCompactPercent, type SessionRecord } from '../sessions.ts';
import { deferToolsEnabled, errorText, groupOf, loadsUpFront, piToolDefs, runToolDef, searchToolDefs, toolSummary } from '../toolset.ts';
import { piModels, resolvePiModel } from '../pi-models.ts';
import type { Engine, TurnContext, TurnResult } from './types.ts';

interface TurnState {
  ctx: TurnContext;
  usage: Usage;
  byModel: Record<string, Usage>;
  model?: string;
  error?: string;
}

interface Entry {
  agent: Agent;
  turn: TurnState | null;
  /** deferred tools activated by tool_search (persisted in engineState.activatedTools) */
  activated: Set<string>;
  /** set when tool_search activated something mid-turn: the next model call gets the new tools */
  toolsDirty: boolean;
  /** every ToolDef the session could use right now (loaded or deferred), by name */
  defs: Map<string, ToolDef>;
}

export const TOOL_SEARCH = 'tool_search';

/** engineState.activatedTools (pi): names of deferred tools loaded by tool_search */
const stateOf = (rec: SessionRecord) => rec.engineState;

const agents = new Map<string, Entry>();

/** test seam (scripts/tests only): a fixed model + stream function, skipping provider auth */
export const piTestHooks: { model?: Model<Api>; streamFn?: StreamFn } = {};

/** JSON schema for a ToolDef's zod schema, as plain JSON (pi validates plain JSON Schema) */
function jsonSchema(def: ToolDef): Record<string, unknown> {
  const js = z.toJSONSchema(def.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  if (js.type !== 'object') return { type: 'object', properties: {}, ...js };
  return js;
}

function resultText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof result === 'string') return result;
  return result == null ? '' : JSON.stringify(result);
}

/**
 * The tool list for the next model call: core tools + tools activated by tool_search (+ the
 * tool_search tool itself while anything is still deferred). With deferral off: everything.
 */
function toolsFor(entry: Entry, rec: SessionRecord): AgentTool<any>[] {
  const all = piToolDefs(rec.kind);
  const defer = deferToolsEnabled();
  entry.defs = new Map(all.map((d) => [d.name, d]));
  const loaded = all.filter((d) => loadsUpFront(d, defer) || entry.activated.has(d.name));
  const list = loaded.map((def) => agentTool(entry, rec.id, def));
  if (defer && loaded.length < all.length) {
    const search = toolSearchDef(entry, rec);
    entry.defs.set(search.name, search);
    list.unshift(agentTool(entry, rec.id, search));
  }
  return list;
}

function agentTool(entry: Entry, sessionId: string, def: ToolDef): AgentTool<any> {
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: jsonSchema(def),
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      const turn = entry.turn;
      if (!turn) throw new Error('No active turn');
      const ok = await turn.ctx.approve({
        callId: toolCallId,
        name: def.name,
        input: params,
        risk: def.risk,
        summary: toolSummary(def, params),
      });
      if (!ok) throw new Error('The user declined this action. Do not retry it; ask how to proceed instead.');
      const text = await runToolDef(def, params, {
        sessionId,
        cwd: turn.ctx.cwd,
        signal: signal ?? turn.ctx.signal,
        progress: (t) => turn.ctx.progress(toolCallId, def.name, t),
      });
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}

/**
 * pi has no native tool search: this tool ranks the deferred tools and ACTIVATES the matches.
 * Activation takes effect on the very next model call of the same turn (prepareNextTurn swaps
 * the loop's tool list; pi-agent-core then declares the additions in the transcript).
 */
function toolSearchDef(entry: Entry, rec: SessionRecord): ToolDef {
  return defineTool({
    name: TOOL_SEARCH,
    description:
      'Find and load tools that are not loaded yet (mail sending/drafts, Slack, calendar edits, automations, processes, ' +
      'extensions, self-evolution, …). Matching tools become callable right after this call. Query with keywords ' +
      '("send email", "slack post") or exact names ("select:slack_post,mail_draft"). Search before saying you cannot do something.',
    risk: 'safe',
    group: 'meta',
    loading: 'always',
    schema: z.object({
      query: z.string().min(1).describe('keywords, or "select:name1,name2" for exact tool names'),
      limit: z.number().int().min(1).max(20).optional().describe('max tools to load (default 5)'),
    }),
    summarize: (i) => `Find tools: ${i.query}`,
    run: ({ query, limit }) => {
      const defer = deferToolsEnabled();
      const candidates = [...entry.defs.values()].filter((d) => d.name !== TOOL_SEARCH && !loadsUpFront(d, defer));
      const hits = searchToolDefs(candidates, query, limit ?? 5);
      if (!hits.length) {
        const groups = [...new Set(candidates.map(groupOf))].join(', ');
        return `No tools matched "${query}". Deferred tool groups: ${groups || '(none)'}. Try other keywords.`;
      }
      const fresh = hits.filter((d) => !entry.activated.has(d.name));
      for (const d of fresh) entry.activated.add(d.name);
      if (fresh.length) {
        entry.toolsDirty = true;
        stateOf(rec).activatedTools = [...entry.activated];
      }
      const lines = hits.map((d) => {
        const desc = d.description.replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0] ?? '';
        return `- ${d.name} [${d.risk}]: ${desc}\n  parameters: ${JSON.stringify(jsonSchema(d))}`;
      });
      return `Loaded ${hits.length} tool(s); call them directly now:\n${lines.join('\n')}`;
    },
  });
}

function onEvent(entry: Entry, ev: AgentEvent): void {
  const turn = entry.turn;
  if (!turn) return;
  const emit = turn.ctx.emit;
  switch (ev.type) {
    case 'message_update': {
      const a = ev.assistantMessageEvent;
      if (a.type === 'text_delta' && a.delta) emit({ type: 'text', delta: a.delta });
      else if (a.type === 'thinking_delta' && a.delta) emit({ type: 'thinking', delta: a.delta });
      break;
    }
    case 'message_end': {
      const m = ev.message as AgentMessage;
      if ((m as any).role !== 'assistant') break;
      const am = m as Extract<AgentMessage, { role: 'assistant' }>;
      if (am.model) {
        turn.model = am.model;
        emit({ type: 'model', model: am.model });
      }
      const u = am.usage;
      if (u) {
        const usage: Usage = {
          inputTokens: u.input || 0,
          outputTokens: u.output || 0,
          cacheReadTokens: u.cacheRead || 0,
          cacheWriteTokens: u.cacheWrite || 0,
          costUsd: u.cost?.total || 0,
        };
        turn.usage = addUsage(turn.usage, usage);
        const key = am.model || 'unknown';
        turn.byModel[key] = addUsage(turn.byModel[key] ?? emptyUsage(), usage);
        const used = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
        if (used > 0) turn.ctx.emit({ type: 'context', used, window: entry.agent.state.model?.contextWindow || undefined });
      }
      if (am.stopReason === 'error' || am.stopReason === 'aborted') turn.error = am.errorMessage || am.stopReason;
      emit({ type: 'assistant-end' });
      break;
    }
    case 'tool_execution_start': {
      const def = entry.defs.get(ev.toolName);
      emit({ type: 'tool-start', callId: ev.toolCallId, name: ev.toolName, input: ev.args, risk: def?.risk });
      break;
    }
    case 'tool_execution_end': {
      emit({
        type: 'tool-end',
        callId: ev.toolCallId,
        ok: !ev.isError,
        output: truncate(resultText(ev.result), 8000),
        durationMs: ev.durationMs,
      });
      break;
    }
    default:
      break;
  }
}

function thinkingFor(model: Model<Api>): ModelThinkingLevel {
  const level = getSettings().pi.thinkingLevel;
  if (!model.reasoning || level === 'off') return 'off';
  try {
    return clampThinkingLevel(model, level);
  } catch {
    return 'off';
  }
}

/* ─────────────── context accounting + compaction ─────────────── */

const DEFAULT_WINDOW = 128_000;
/** recent user turns kept verbatim by a compaction */
const KEEP_TURNS = 2;
const roleOf = (m: unknown) => (m as any)?.role as string | undefined;

/** rough token estimate (chars / 4) of a message list */
function estimateTokens(messages: unknown[], systemPrompt = ''): number {
  let chars = systemPrompt.length;
  for (const m of messages) chars += JSON.stringify((m as any)?.content ?? '').length;
  return Math.ceil(chars / 4);
}

/**
 * Current context size: the latest (post-compaction) assistant usage — input + cache + output — plus an
 * estimate of anything appended after it (tool results, a new prompt). No usage yet → estimate everything.
 */
export function piContextTokens(messages: unknown[], systemPrompt: string, usageFrom = 0): number {
  for (let i = messages.length - 1; i >= Math.max(0, usageFrom); i--) {
    const m = messages[i] as any;
    if (m?.role !== 'assistant' || !m.usage) continue;
    const u = m.usage;
    const base = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
    if (base > 0) return base + estimateTokens(messages.slice(i + 1));
  }
  return estimateTokens(messages, systemPrompt);
}

const SUMMARY_PROMPT = `You compact a long agent conversation so it can continue in a fresh context window.
Write a dense, faithful summary of the transcript you are given. Use these sections (omit empty ones):
## Goals — what the user wants overall and right now
## Decisions — choices made and why, constraints and preferences the user stated
## Files & resources — files read/created/edited (paths), commands run, URLs, ids, with what changed
## Work done — what was completed, key results and numbers
## Open tasks — what is still pending or was promised, next steps
## Important facts — names, values, errors and anything else needed to continue without the original transcript
Be specific (exact paths, names, values). Do not invent anything. Output only the summary.`;

function blockText(b: any): string {
  if (!b) return '';
  if (b.type === 'text') return b.text ?? '';
  if (b.type === 'thinking') return '';
  if (b.type === 'toolCall') return `[tool call ${b.name} ${truncate(JSON.stringify(b.arguments ?? {}), 600)}]`;
  if (b.type === 'image') return '[image]';
  return '';
}

/** plain-text rendering of pi messages for the summarizer (tool output clipped) */
function renderTranscript(messages: unknown[], maxChars: number): string {
  const lines: string[] = [];
  for (const m of messages as any[]) {
    const content = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map(blockText).filter(Boolean).join('\n') : '';
    if (m?.role === 'user') lines.push(`USER: ${content}`);
    else if (m?.role === 'assistant') lines.push(`ASSISTANT: ${content}`);
    else if (m?.role === 'toolResult') lines.push(`TOOL RESULT (${m.toolName ?? 'tool'}${m.isError ? ', error' : ''}): ${truncate(content, 1500)}`);
  }
  let text = lines.join('\n\n');
  if (text.length > maxChars) text = `${text.slice(0, Math.floor(maxChars * 0.3))}\n\n[… middle of the transcript omitted …]\n\n${text.slice(-Math.floor(maxChars * 0.7))}`;
  return text;
}

/** index where the kept tail starts: at a user prompt (never splits a tool call from its result) */
function cutIndex(messages: unknown[], window: number): number {
  const userIdx = messages.map((m, i) => (roleOf(m) === 'user' ? i : -1)).filter((i) => i >= 0);
  for (let keep = Math.min(KEEP_TURNS, userIdx.length - 1); keep > 0; keep--) {
    const cut = userIdx[userIdx.length - keep];
    // the kept tail must leave real room; otherwise keep fewer turns
    if (estimateTokens(messages.slice(cut)) < window * 0.3) return cut;
  }
  return messages.length; // summarize everything
}

function syntheticAssistant(model: Model<Api>, text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/**
 * Summarize the older part of the persisted transcript with the session's own model, keep the recent turns
 * verbatim, persist, and drop the cached Agent so the next turn rebuilds it from the new transcript.
 */
async function compactPi(ctx: TurnContext, model: Model<Api>, trigger: 'auto' | 'manual', streamFn: StreamFn): Promise<{ usage: Usage; error?: string }> {
  const rec = ctx.session;
  const cached = agents.get(rec.id);
  if (cached?.turn) return { usage: emptyUsage(), error: 'This session is still busy.' };
  const messages = (cached ? cached.agent.state.messages.filter((m) => roleOf(m) !== 'system') : (rec.engineState.piMessages ?? [])) as AgentMessage[];
  const window = model.contextWindow || DEFAULT_WINDOW;
  const pre = piContextTokens(messages, ctx.systemPrompt, rec.engineState.piUsageFrom ?? 0);
  if (!messages.length) return { usage: emptyUsage(), error: 'Nothing to compact yet.' };
  const cut = cutIndex(messages, window);
  const older = messages.slice(0, cut);
  const kept = messages.slice(cut);
  if (!older.length) return { usage: emptyUsage(), error: 'Nothing to compact yet.' };

  ctx.emit({ type: 'phase', phase: 'thinking', detail: 'Compacting context' });
  const transcript = renderTranscript(older, Math.floor(window * 0.6 * 4));
  const stream = streamFn(
    model,
    { systemPrompt: SUMMARY_PROMPT, messages: [{ role: 'user', content: `<transcript>\n${transcript}\n</transcript>\n\nSummarize this transcript now.`, timestamp: Date.now() }] } as any,
    { signal: ctx.signal, sessionId: rec.id } as any,
  );
  const res: any = await (stream as any).result();
  if (res?.stopReason === 'error' || res?.stopReason === 'aborted') return { usage: emptyUsage(), error: `Compaction failed: ${res.errorMessage || res.stopReason}` };
  const summary = (res?.content ?? []).map((b: any) => (b.type === 'text' ? b.text : '')).join('').trim();
  if (!summary) return { usage: emptyUsage(), error: 'Compaction failed: the model returned an empty summary.' };
  const u = res.usage ?? {};
  const usage: Usage = { inputTokens: u.input || 0, outputTokens: u.output || 0, cacheReadTokens: u.cacheRead || 0, cacheWriteTokens: u.cacheWrite || 0, costUsd: u.cost?.total || 0 };

  const head: AgentMessage[] = [
    { role: 'user', content: `[Context summary — the earlier part of this conversation was compacted by Monarch]\n\n${summary}`, timestamp: Date.now() } as AgentMessage,
    syntheticAssistant(model, 'Understood. I have the summary of our earlier conversation and will continue from it.'),
  ];
  const next = [...head, ...kept];
  rec.engineState.piMessages = next;
  rec.engineState.piUsageFrom = next.length; // kept assistant messages carry pre-compaction usage
  agents.delete(rec.id); // rebuilt from piMessages on the next turn
  ctx.save();
  const post = estimateTokens(next, ctx.systemPrompt);
  ctx.emit({ type: 'compacted', trigger, pre, post });
  ctx.emit({ type: 'context', used: post, window });
  return { usage };
}

interface Resolved {
  model: Model<Api>;
  streamFn: StreamFn;
}

async function resolveForTurn(ctx: TurnContext): Promise<Resolved | TurnResult> {
  const settings = getSettings().pi;
    const rec = ctx.session;
    const providerId = rec.engineState.piProvider || settings.provider;
    const modelSpec = rec.model || settings.model;
    const { provider, model } = piTestHooks.model
      ? { provider: piTestHooks.model.provider, model: piTestHooks.model }
      : resolvePiModel(providerId, modelSpec);
    if (!model) {
      return { usage: emptyUsage(), error: `Unknown model "${modelSpec}" for provider "${providerId}". Pick a model in Config.` };
    }
    if (provider !== rec.engineState.piProvider) {
      rec.engineState.piProvider = provider;
      ctx.save();
    }

    const models = piModels();
    const streamFn: StreamFn = (m, c, o) => (piTestHooks.streamFn ?? models.streamSimple.bind(models))(m, c, o);
    try {
      const auth = piTestHooks.model ? true : await models.checkAuth(provider);
      if (!auth) {
        return {
          usage: emptyUsage(),
          model: model.id,
          error: `No credentials for provider "${provider}". Add an API key or sign in under Config → Providers.`,
        };
      }
    } catch (e) {
      return { usage: emptyUsage(), model: model.id, error: `Credential check failed for "${provider}": ${errorText(e)}` };
    }
    return { model, streamFn };
}

/** auto-compact when the context is at/over the configured threshold; returns compaction usage */
async function maybeAutoCompact(ctx: TurnContext, r: Resolved, extra = ''): Promise<Usage> {
  const pct = autoCompactPercent();
  if (pct <= 0) return emptyUsage();
  const rec = ctx.session;
  const cached = agents.get(rec.id);
  const messages = cached ? cached.agent.state.messages.filter((m) => roleOf(m) !== 'system') : (rec.engineState.piMessages ?? []);
  if (messages.length <= 2) return emptyUsage(); // nothing left worth summarizing (e.g. just a summary)
  const window = r.model.contextWindow || DEFAULT_WINDOW;
  const used = piContextTokens(messages, ctx.systemPrompt, rec.engineState.piUsageFrom ?? 0) + Math.ceil(extra.length / 4);
  if ((used / window) * 100 < pct) return emptyUsage();
  try {
    const out = await compactPi(ctx, r.model, 'auto', r.streamFn);
    if (out.error) console.warn(`[pi] auto-compaction skipped: ${out.error}`);
    return out.usage;
  } catch (e) {
    console.warn('[pi] auto-compaction failed', e);
    return emptyUsage();
  }
}

export const piEngine: Engine = {
  id: 'pi',
  async compact(ctx: TurnContext): Promise<TurnResult> {
    const r = await resolveForTurn(ctx);
    if (!('streamFn' in r)) return r;
    try {
      const out = await compactPi(ctx, r.model, 'manual', r.streamFn);
      return { usage: out.usage, byModel: { [r.model.id]: out.usage }, model: r.model.id, error: out.error };
    } catch (e) {
      return { usage: emptyUsage(), model: r.model.id, error: `Compaction failed: ${errorText(e)}` };
    }
  },
  async runTurn(ctx: TurnContext): Promise<TurnResult> {
    const r = await resolveForTurn(ctx);
    if (!('streamFn' in r)) return r;
    const { model, streamFn } = r;
    const rec = ctx.session;
    const preUsage = await maybeAutoCompact(ctx, r, ctx.text);

    let entry = agents.get(rec.id);
    if (!entry) {
      const known = new Set(piToolDefs(rec.kind).map((d) => d.name));
      const fresh: Entry = {
        agent: null as unknown as Agent,
        turn: null,
        // tools that no longer exist (removed extension) are dropped; their old calls stay in history
        activated: new Set((stateOf(rec).activatedTools ?? []).filter((n) => known.has(n))),
        toolsDirty: false,
        defs: new Map(),
      };
      const restored = (rec.engineState.piMessages ?? []) as AgentMessage[];
      fresh.agent = new Agent({
        initialState: {
          systemPrompt: ctx.systemPrompt,
          model,
          thinkingLevel: thinkingFor(model),
          tools: toolsFor(fresh, rec),
          messages: restored,
        },
        streamFn,
        // mid-turn tool activation: after a turn whose tool_search loaded new tools, hand the loop
        // the refreshed list (same message array) so the next model call can use them
        prepareNextTurnWithContext: (turnCtx) => {
          if (!fresh.toolsDirty) return undefined;
          fresh.toolsDirty = false;
          const tools = toolsFor(fresh, rec);
          fresh.agent.state.tools = tools;
          return { context: { messages: turnCtx.context.messages, tools } };
        },
        sessionId: rec.id,
        toolExecution: 'sequential',
        identity: { attribution: null, userAgent: 'short' },
      });
      fresh.agent.subscribe((ev) => onEvent(fresh, ev));
      agents.set(rec.id, fresh);
      entry = fresh;
    } else {
      entry.agent.state.model = model;
      entry.agent.state.thinkingLevel = thinkingFor(model);
      // extension tools come and go; activated tools stay; refresh every turn
      entry.agent.state.tools = toolsFor(entry, rec);
      entry.toolsDirty = false;
    }

    if (entry.agent.state.isStreaming) {
      return { usage: emptyUsage(), model: model.id, error: 'This session is still busy.' };
    }

    const turn: TurnState = { ctx, usage: preUsage, byModel: preUsage.inputTokens ? { [model.id]: preUsage } : {}, model: model.id };
    entry.turn = turn;
    ctx.emit({ type: 'model', model: model.id });

    const agent = entry.agent;
    const onAbort = () => agent.abort();
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await agent.prompt(ctx.text);
    } catch (e) {
      turn.error = turn.error ?? errorText(e);
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      entry.turn = null;
      rec.engineState.piMessages = agent.state.messages.filter((m) => (m as any).role !== 'system');
      ctx.save();
    }

    if (ctx.signal.aborted) return { usage: turn.usage, byModel: turn.byModel, model: turn.model, error: 'aborted' };
    ctx.emit({ type: 'context', used: piContextTokens(rec.engineState.piMessages ?? [], ctx.systemPrompt, rec.engineState.piUsageFrom ?? 0), window: model.contextWindow || DEFAULT_WINDOW });
    if (!turn.error) {
      const post = await maybeAutoCompact(ctx, r);
      if (post.inputTokens || post.outputTokens) {
        turn.usage = addUsage(turn.usage, post);
        turn.byModel[model.id] = addUsage(turn.byModel[model.id] ?? emptyUsage(), post);
      }
    }
    return { usage: turn.usage, byModel: turn.byModel, model: turn.model, error: turn.error };
  },
  dispose(sessionId: string) {
    const e = agents.get(sessionId);
    if (!e) return;
    try {
      e.agent.abort();
    } catch {
      /* ignore */
    }
    agents.delete(sessionId);
    try {
      cleanupSessionResources(sessionId);
    } catch {
      /* ignore */
    }
  },
};

/** forget all cached agents (e.g. after provider/model settings changed) */
export function resetPiAgents(): void {
  for (const id of [...agents.keys()]) if (!agents.get(id)?.turn) piEngine.dispose!(id);
}
