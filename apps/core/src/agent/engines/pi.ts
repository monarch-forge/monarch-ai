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
import { deferToolsEnabled, errorText, loadsUpFront, piToolDefs, runToolDef, smallModeFor, toolJsonSchema, toolSearchReport, toolSummary } from '../toolset.ts';
import { parseLooseObject, parseTextToolCalls, textToolResultsMessage, type TextToolCall } from '../text-tools.ts';
import { codingAgentsBrief } from '../../tools/delegate.ts';
import { piModels, resolvePiModel } from '../pi-models.ts';
import type { Engine, TurnContext, TurnResult } from './types.ts';
import { autonomyHigh, CONTINUE_NUDGE, earlyStopReason, MAX_AUTO_CONTINUE, noteTokenSaver } from '../autonomy.ts';

interface TurnState {
  ctx: TurnContext;
  usage: Usage;
  byModel: Record<string, Usage>;
  model?: string;
  error?: string;
  /** full text of the current assistant message */
  msg: string;
  /** how much of `msg` has been streamed to the UI (the rest is held back: may be a fragment / text tool call) */
  out: number;
  /** the current message turned into tool-call text: stream nothing more of it */
  suppress: boolean;
  /** tool calls the last assistant message wrote as text (no native calls): run by the text-tool fallback */
  textCalls?: TextToolCall[];
  /** raw streamed argument text of native tool calls in the current message, by content index */
  rawArgs: Record<number, string>;
  /** the last assistant message was suppressed as a fragment */
  fragment?: string;
  /** the last reply was cut off for lack of room in the context window */
  starved?: boolean;
  /** tool calls executed in this turn (native + text fallback) */
  toolCalls: number;
  /** full text of the last assistant message that had no tool calls (autonomy check) */
  lastReply: string;
}

interface Entry {
  /** small-model mode for the model this Agent last ran with */
  small: boolean;
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
  return toolJsonSchema(def);
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
  const loaded = all.filter((d) => loadsUpFront(d, defer, entry.small) || entry.activated.has(d.name));
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
        small: entry.small,
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
      const all = [...entry.defs.values()].filter((d) => d.name !== TOOL_SEARCH);
      const isLoaded = (d: ToolDef) => loadsUpFront(d, defer, entry.small) || entry.activated.has(d.name);
      const { text, activate } = toolSearchReport(all, isLoaded, query, limit ?? 5);
      if (activate.length) {
        for (const n of activate) entry.activated.add(n);
        entry.toolsDirty = true;
        stateOf(rec).activatedTools = [...entry.activated];
      }
      return text;
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
      if (a.type === 'text_delta' && a.delta) {
        turn.msg += a.delta;
        pump(entry, turn);
      }
      else if (a.type === 'thinking_delta' && a.delta) emit({ type: 'thinking', delta: a.delta });
      else if (a.type === 'toolcall_delta' && a.delta) turn.rawArgs[a.contentIndex] = (turn.rawArgs[a.contentIndex] ?? '') + a.delta;
      else if (a.type === 'toolcall_end') {
        // native call whose arguments were not JSON (e.g. `{path:<|"|>x<|"|>}`): pi-ai parsed them as {} — re-read them leniently
        const raw = turn.rawArgs[a.contentIndex]?.trim();
        delete turn.rawArgs[a.contentIndex];
        const tc = a.toolCall as { name: string; arguments?: Record<string, unknown> };
        if (raw && raw !== "{}" && (!tc.arguments || !Object.keys(tc.arguments).length) && raw.includes("{")) {
          const p = parseLooseObject(raw, raw.indexOf('{'));
          if (p && Object.keys(p.value).length) {
            tc.arguments = p.value;
            console.info(`[pi] recovered non-JSON arguments of native ${tc.name} call (${raw.length} chars)`);
          } else console.warn(`[pi] ${tc.name} call arguments unreadable: ${JSON.stringify(raw.slice(0, 120))}`);
        }
      }
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
      const hasToolCall = Array.isArray(am.content) && am.content.some((b: any) => b?.type === 'toolCall');
      // out of room: the provider cut the reply after a few tokens (max_tokens clamped to what is left of the window)
      const starved = am.stopReason === 'length' && !hasToolCall && (am.usage?.output ?? 0) < 16;
      if (starved) turn.starved = true;
      const rest = turn.msg.slice(turn.out);
      const parsed = !hasToolCall && turn.msg.trim() ? parseTextToolCalls(turn.msg, entry.defs.keys()) : undefined;
      if (parsed?.calls.length) {
        // tool calls written as text: keep them out of the UI, the fallback executes them
        const first = turn.msg.indexOf(parsed.calls[0].raw);
        if (first > turn.out) {
          const before = turn.msg.slice(turn.out, first).trimEnd();
          if (before.trim()) emit({ type: 'text', delta: before });
        }
        turn.textCalls = parsed.calls;
      } else if (rest) {
        if (!hasToolCall && (starved || isFragment(rest))) turn.fragment = rest;
        else emit({ type: 'text', delta: rest });
      } else if (starved && turn.out === 0) turn.fragment = turn.fragment ?? '';
      turn.lastReply = hasToolCall || parsed?.calls.length ? '' : turn.msg;
      turn.msg = '';
      turn.out = 0;
      turn.suppress = false;
      turn.rawArgs = {};
      emit({ type: 'assistant-end' });
      break;
    }
    case 'tool_execution_start': {
      turn.toolCalls++;
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

/* ─────────────── stray-output guard ─────────────── */

/** text that could still turn out to be a tool call written as text: hold it back from the UI */
function mayBeFragment(text: string): boolean {
  const t = text.trimStart();
  if (t.length < 24 && !t.includes('\n')) return true; // could still be a cut-off reply ("Day", "Task")
  if (!/^[{\[`]/.test(t)) return false;
  return t.length < 400;
}

/** stream what is safe of the current message; hold back anything that may become a (text) tool call */
export function pump(entry: Entry, turn: TurnState): void {
  if (turn.suppress) return;
  if (turn.out === 0 && mayBeFragment(turn.msg)) return;
  const names = entry.defs;
  const send = (chunk: string) => {
    if (!chunk) return;
    turn.out += chunk.length;
    turn.ctx.emit({ type: 'text', delta: chunk });
  };
  for (;;) {
    const tail = turn.msg.slice(turn.out);
    if (!tail) return;
    const atLineStart = turn.out === 0 || turn.msg[turn.out - 1] === '\n';
    const nl = tail.indexOf('\n');
    // Gemma-style thinking channel leaked into the text: route it to the thinking stream
    const ch = /^\s*<\|channel>/.exec(tail);
    if (ch || (atLineStart && '<|channel>'.startsWith(tail.trimStart()) && tail.trim())) {
      if (!ch) return;
      const close = tail.indexOf('<channel|>');
      if (close < 0) return;
      const inner = tail.slice(ch[0].length, close).replace(/^thought\s*/, '');
      turn.out += close + '<channel|>'.length;
      if (inner.trim()) turn.ctx.emit({ type: 'thinking', delta: inner });
      continue;
    }
    const line = nl < 0 ? tail : tail.slice(0, nl);
    const hit = findCall(line, names);
    if (hit >= 0) {
      send(line.slice(0, hit).replace(/[`\s]+$/, ''));
      turn.suppress = true;
      return;
    }
    if (atLineStart && /^\s*(?:```|\{)/.test(line) && (nl < 0 || /^\s*(?:```[\w-]*|[{\[])\s*$/.test(line))) {
      // a fence / JSON opener: decide together with the next line(s)
      const rest = nl < 0 ? '' : tail.slice(nl + 1);
      const nl2 = rest.indexOf('\n');
      const next = nl2 < 0 ? rest : rest.slice(0, nl2);
      if (nl >= 0 && (findCall(next, names) >= 0 || /"(?:name|tool|function)"\s*:/.test(next))) {
        turn.suppress = true;
        return;
      }
      if ((nl < 0 || nl2 < 0) && tail.length < 300) return;
    }
    if (nl < 0) {
      send(line.slice(0, safeLength(line, names)));
      return;
    }
    send(tail.slice(0, nl + 1));
  }
}

const CALL_AT = /(?:^|[^\w.])((?:\w*call\w*\s*:\s*)?`*([A-Za-z_][\w.]*)`?\s*[{(])/g;

/** index in `line` where a tool call written as text starts (`fs_write{…`, `tool_call:fs_read(…`, `{"name": …`), or -1 */
function findCall(line: string, names: Map<string, unknown>): number {
  let best = -1;
  for (const m of line.matchAll(CALL_AT)) {
    if (!names.has(m[2].split('.').pop()!)) continue;
    best = m.index! + (m[0].length - m[1].length);
    break;
  }
  const j = /\{\s*"(?:name|tool|function)"\s*:/.exec(line);
  if (j && (best < 0 || j.index < best)) best = j.index;
  return best;
}

/** how much of an unfinished line is safe to stream: stop before a trailing word that may still become a call */
function safeLength(line: string, names: Map<string, unknown>): number {
  const m = /((?:\w*call\w*\s*:\s*)?`*([A-Za-z_][\w.]*)?(\s*))$/.exec(line);
  if (!m || !m[1]) return line.length;
  const start = line.length - m[1].length;
  if (start > 0 && /[\w.]/.test(line[start - 1])) return line.length;
  const word = m[2];
  if (!word) return /call\w*\s*:/.test(m[1]) || m[1].includes('`') ? start : line.length;
  const seg = word.split('.').pop()!;
  if (m[3]) return names.has(seg) ? start : line.length;
  if (!seg) return line.length; // "word." ends a sentence
  for (const n of names.keys()) if (n.startsWith(seg)) return start;
  return /call\w*\s*:/.test(m[1]) ? start : line.length;
}

/** a reply that is only a piece of JSON / tool-call syntax (not a real answer) */
export function isFragment(text: string): boolean {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (!t) return false;
  if (/^[{\[]"?\s*$/.test(t)) return true;
  if (!/^[{\[]/.test(t)) return false;
  try {
    JSON.parse(t);
    // complete JSON that looks like a tool call written as text
    return /"(name|tool|function|arguments|args|parameters)"\s*:/.test(t);
  } catch {
    return t.length < 400; // truncated JSON
  }
}

const NUDGE =
  'Your last reply was cut off. If you meant to call a tool, call it properly with a tool call ' +
  '(if you cannot, write it on its own line as tool_name{"arg": "value"} and it will be run); otherwise answer in plain text.';

function fragmentToolName(text: string): string | undefined {
  return /"(?:name|tool|function)"\s*:\s*"([a-z0-9_]+)"/i.exec(text)?.[1];
}

/** drop the trailing suppressed assistant message (and a trailing nudge) from the transcript */
function dropTrailingFragment(agent: Agent): void {
  const msgs = agent.state.messages;
  const last = msgs[msgs.length - 1] as any;
  if (last?.role === 'assistant') agent.state.messages = msgs.slice(0, -1);
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
async function compactPi(ctx: TurnContext, model: Model<Api>, trigger: 'auto' | 'manual', streamFn: StreamFn, inPlace = false): Promise<{ usage: Usage; error?: string }> {
  const rec = ctx.session;
  const cached = agents.get(rec.id);
  if (cached?.turn && !inPlace) return { usage: emptyUsage(), error: 'This session is still busy.' };
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
  rec.engineState.codingAgentsNote = undefined; // re-announce the coding agents after a compaction
  if (inPlace && cached) {
    // mid-turn (out of room): swap the live transcript, keep the leading system message
    const lead = cached.agent.state.messages[0];
    cached.agent.state.messages = roleOf(lead) === 'system' ? [lead, ...next] : next;
  } else agents.delete(rec.id); // rebuilt from piMessages on the next turn
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
  // pi-ai clamps max_tokens to window - input - 4096 (safety margin): on small windows the % threshold
  // alone can leave no room to answer, so also compact when less than ~2k tokens of output would remain
  const roomy = window - used - 4096 >= 2048;
  if ((used / window) * 100 < pct && roomy) return emptyUsage();
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

    const small = smallModeFor(model.id, model.name, model.contextWindow);
    let entry = agents.get(rec.id);
    // small-model mode changed (model switch / setting): rebuild with the matching prompt + tool set
    if (entry && entry.small !== small && !entry.turn) {
      agents.delete(rec.id);
      entry = undefined;
    }
    if (!entry) {
      const known = new Set(piToolDefs(rec.kind).map((d) => d.name));
      const fresh: Entry = {
        small,
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

    const turn: TurnState = { ctx, usage: preUsage, byModel: preUsage.inputTokens ? { [model.id]: preUsage } : {}, model: model.id, msg: '', out: 0, suppress: false, rawArgs: {}, toolCalls: 0, lastReply: '' };
    entry.turn = turn;
    ctx.emit({ type: 'model', model: model.id });

    const agent = entry.agent;
    const onAbort = () => agent.abort();
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await agent.prompt(await withAgentsNote(rec, ctx.text));
      await drainTextCalls(entry, rec, turn, model);
      // stray-output guard: the turn ended with a bare tool-call fragment as text → retry once
      if (turn.fragment !== undefined && !turn.error && !ctx.signal.aborted) {
        const first = turn.fragment;
        console.warn(`[pi] suppressed ${turn.starved ? 'cut-off (no room)' : 'fragment'} reply ${JSON.stringify(first.slice(0, 80))}; retrying once`);
        turn.fragment = undefined;
        dropTrailingFragment(agent);
        if (turn.starved) {
          turn.starved = false;
          // make room first: summarize the older turns in place, then let the model answer again
          try {
            const out = await compactPi(ctx, model, 'auto', streamFn, true);
            if (out.error) console.warn(`[pi] in-turn compaction skipped: ${out.error}`);
            turn.usage = addUsage(turn.usage, out.usage);
          } catch (e) {
            console.warn('[pi] in-turn compaction failed', e);
          }
        }
        const nudge = { role: 'user', content: `[Monarch system note] ${NUDGE}`, timestamp: Date.now() } as AgentMessage;
        agent.state.messages = [...agent.state.messages, nudge];
        await agent.continue();
        await drainTextCalls(entry, rec, turn, model);
        // keep the transcript clean: drop the nudge (and a second fragment)
        if (turn.fragment !== undefined) dropTrailingFragment(agent);
        agent.state.messages = agent.state.messages.filter((m) => m !== nudge);
        if (turn.fragment !== undefined && !turn.error) {
          const tool = fragmentToolName(turn.fragment) ?? fragmentToolName(first);
          const msg = `Sorry — my reply got cut off${tool ? ` while I was trying to use ${tool}` : ' while I was trying to call a tool'}. Could you say that again, or rephrase it?`;
          ctx.emit({ type: 'text', delta: msg });
          ctx.emit({ type: 'assistant-end' });
          agent.state.messages = [...agent.state.messages, syntheticAssistant(model, msg)];
        }
      }
      await autoContinue(entry, rec, turn, model);
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

/* ─────────────── autonomy loop ─────────────── */

/** tool calls per turn after which Monarch no longer pushes the model to keep going */
const AUTO_CONTINUE_TOOL_BUDGET = 80;
let autoSeq = 0;

/**
 * Settings.agent.autonomy 'high': the turn ended with plain text that defers/skips requested work, announces
 * work without doing it, or asks "shall I…" after an imperative instruction → continue with a short system
 * nudge (up to MAX_AUTO_CONTINUE extra rounds). A small "Continued automatically" card marks each round.
 */
async function autoContinue(entry: Entry, rec: SessionRecord, turn: TurnState, model: Model<Api>): Promise<void> {
  const ctx = turn.ctx;
  noteTokenSaver(turn.lastReply, rec.id);
  if (!autonomyHigh() || rec.kind === 'automation') return;
  const agent = entry.agent;
  let roundStart = 0;
  for (let i = 0; i < MAX_AUTO_CONTINUE; i++) {
    if (turn.error || ctx.signal.aborted || turn.fragment !== undefined) return;
    if (turn.toolCalls >= AUTO_CONTINUE_TOOL_BUDGET) return;
    const reason = earlyStopReason(turn.lastReply, ctx.text, turn.toolCalls - roundStart);
    if (!reason) return;
    console.info(`[pi] session ${rec.id}: reply ${reason}; continuing automatically (${i + 1}/${MAX_AUTO_CONTINUE})`);
    const callId = `autocontinue_${Date.now().toString(36)}_${++autoSeq}`;
    ctx.emit({ type: 'tool-start', callId, name: 'continued_automatically', input: { reason, round: i + 1 } });
    ctx.emit({ type: 'tool-end', callId, ok: true, output: `Continued automatically: the reply ${reason}.`, durationMs: 0 });
    roundStart = turn.toolCalls;
    turn.lastReply = '';
    const nudge = { role: 'user', content: `[Monarch system note] ${CONTINUE_NUDGE}`, timestamp: Date.now() } as AgentMessage;
    agent.state.messages = [...agent.state.messages, nudge];
    try {
      await agent.continue();
      await drainTextCalls(entry, rec, turn, model);
    } finally {
      agent.state.messages = agent.state.messages.filter((m) => m !== nudge);
    }
    if (turn.fragment !== undefined) {
      dropTrailingFragment(agent);
      turn.fragment = undefined;
      return;
    }
    noteTokenSaver(turn.lastReply, rec.id);
  }
}

/* ─────────────── text tool-call fallback ─────────────── */

const MAX_TEXT_ROUNDS = 8;
const textToolSessions = new Set<string>();
let textCallSeq = 0;

/**
 * Some models (OpenAI-compatible proxies, Gemma-style chat templates) never emit native tool calls and
 * write them as text instead (`fs_write{path: …}`). When an assistant message had no native calls but
 * parseable calls to known tools, run them through the same path as native calls (approval, arg repair,
 * runToolDef, tool cards), hand the results back as a user message and let the model continue.
 */
async function drainTextCalls(entry: Entry, rec: SessionRecord, turn: TurnState, model: Model<Api>): Promise<void> {
  const ctx = turn.ctx;
  let rounds = 0;
  while (turn.textCalls?.length && !turn.error && !ctx.signal.aborted) {
    if (rounds >= MAX_TEXT_ROUNDS) {
      turn.textCalls = undefined;
      const msg = `I stopped after ${MAX_TEXT_ROUNDS} rounds of tool calls in this turn. Tell me if I should keep going.`;
      ctx.emit({ type: 'text', delta: msg });
      ctx.emit({ type: 'assistant-end' });
      entry.agent.state.messages = [...entry.agent.state.messages, syntheticAssistant(model, msg)];
      return;
    }
    rounds++;
    const calls = turn.textCalls;
    turn.textCalls = undefined;
    if (!textToolSessions.has(rec.id)) {
      textToolSessions.add(rec.id);
      console.warn(`[pi] model ${model.id} writes tool calls as text (no native tool calls); session ${rec.id} uses the text tool-call fallback`);
    }
    const results: { name: string; ok: boolean; output: string }[] = [];
    for (const call of calls) {
      if (ctx.signal.aborted) break;
      results.push(await runTextCall(entry, rec, turn, call));
    }
    if (ctx.signal.aborted) return;
    if (entry.toolsDirty) {
      entry.toolsDirty = false;
      entry.agent.state.tools = toolsFor(entry, rec);
    }
    const note = { role: 'user', content: textToolResultsMessage(results), timestamp: Date.now() } as AgentMessage;
    entry.agent.state.messages = [...entry.agent.state.messages, note];
    await entry.agent.continue();
  }
}

async function runTextCall(entry: Entry, rec: SessionRecord, turn: TurnState, call: TextToolCall): Promise<{ name: string; ok: boolean; output: string }> {
  const ctx = turn.ctx;
  const def = entry.defs.get(call.name);
  const callId = `textcall_${Date.now().toString(36)}_${++textCallSeq}`;
  turn.toolCalls++;
  ctx.emit({ type: 'tool-start', callId, name: call.name, input: call.args, risk: def?.risk });
  const t0 = Date.now();
  const end = (ok: boolean, output: string) => {
    ctx.emit({ type: 'tool-end', callId, ok, output: truncate(output, 8000), durationMs: Date.now() - t0 });
    return { name: call.name, ok, output: truncate(output, 12000) };
  };
  if (!def) return end(false, `Unknown tool ${call.name}.`);
  try {
    const ok = await ctx.approve({ callId, name: def.name, input: call.args, risk: def.risk, summary: toolSummary(def, call.args) });
    if (!ok) return end(false, 'The user declined this action. Do not retry it; ask how to proceed instead.');
    const text = await runToolDef(def, call.args, {
      sessionId: rec.id,
      cwd: ctx.cwd,
      signal: ctx.signal,
      progress: (t) => ctx.progress(callId, def.name, t),
      small: entry.small,
    });
    return end(true, text);
  } catch (e) {
    return end(false, errorText(e));
  }
}

/**
 * Live "your coding agents" note for pi: prefixed to the user turn only when the list changed since the
 * last note in this session, so the (cached) system prompt and transcript prefix stay stable.
 */
async function withAgentsNote(rec: SessionRecord, text: string): Promise<string> {
  if (rec.kind === 'coding') return text;
  let brief = '';
  try {
    brief = await codingAgentsBrief(rec.id);
  } catch {
    brief = '';
  }
  if (!brief || brief === stateOf(rec).codingAgentsNote) return text;
  stateOf(rec).codingAgentsNote = brief;
  return `<context>\nYour worker agents (manage them with agent_send/status/wait; newest first):\n${brief}\n</context>\n\n${text}`;
}

/** forget all cached agents (e.g. after provider/model settings changed) */
export function resetPiAgents(): void {
  for (const id of [...agents.keys()]) if (!agents.get(id)?.turn) piEngine.dispose!(id);
}
