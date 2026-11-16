/**
 * Worker agents (group 'coding-agents'): lets a chat agent delegate work to a Workshop coding session and
 * manage it like a lead engineer — start, follow up, check status, wait for the result, list, abort.
 *
 * The child session is an ordinary 'coding' session (own cwd, file/shell tools, own approvals). Approvals
 * raised inside it go through the normal approvals flow (broadcast to the dock with the child's sessionId).
 * The child records `parentSessionId`; when it goes idle the orchestrator posts a notification linking to it.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { ChatItem, EngineId } from '@monarch/shared';
import { defineTool, type ToolDef } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { looksLikeTextToolCall } from '../agent/text-tools.ts';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const orch = () => import('../agent/orchestrator.ts');
const sess = () => import('../agent/sessions.ts');
const appr = () => import('../agent/approvals.ts');

/* ─────────────── model selection ─────────────── */

const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];

/** every model of every configured provider, as the specs agent_start accepts */
async function availableModels(): Promise<{ engine: EngineId; spec: string; name: string; provider: string; context?: number; reasoning?: boolean }[]> {
  const { listAvailableModels } = await import('../agent/providers.ts');
  const list = await listAvailableModels();
  return list.map((m) => ({
    engine: m.engine,
    spec: m.engine === 'pi' ? `${m.provider}/${m.id}` : m.id,
    name: m.name,
    provider: m.provider,
    context: m.contextWindow,
    reasoning: m.reasoning,
  }));
}

/** check an engine/model choice before starting a session; returns the normalized pair or throws with suggestions */
async function validateModel(engine: EngineId | undefined, model: string | undefined): Promise<{ engine?: EngineId; model?: string }> {
  const want = model?.trim();
  if (!want) return { engine };
  const eff: EngineId = engine ?? (want.includes('/') ? 'pi' : getSettings().engine);
  if (eff === 'claude-sdk' && CLAUDE_ALIASES.includes(want.toLowerCase())) return { engine: eff, model: want.toLowerCase() };
  const all = await availableModels();
  const mine = all.filter((m) => m.engine === eff);
  const lw = want.toLowerCase();
  const hit = mine.find((m) => m.spec.toLowerCase() === lw) ?? (eff === 'pi' ? mine.find((m) => m.spec.toLowerCase().endsWith(`/${lw}`)) : undefined);
  if (hit) return { engine: eff, model: hit.spec };
  const close = mine.filter((m) => m.spec.toLowerCase().includes(lw) || m.name.toLowerCase().includes(lw)).slice(0, 8).map((m) => m.spec);
  throw new Error(
    `Model "${want}" is not available on ${eff === 'pi' ? 'pi' : 'Claude'}.` +
      (close.length ? ` Close matches: ${close.join(', ')}.` : ` Call agent_models to see the models you can use.`) +
      (eff === 'claude-sdk' ? ' Claude also accepts the aliases opus, sonnet, haiku.' : ''),
  );
}

const link = (id: string) => `#/workshop/${encodeURIComponent(id)}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** absolute path, "~/x", or the name (basename) of a remembered Workshop workspace */
export function resolveWorkspace(spec: string | undefined): string {
  const s = getSettings().coding;
  const raw = spec?.trim();
  if (!raw) {
    if (!s.defaultWorkspace) throw new Error('No cwd given and no default workspace configured (Config → coding).');
    return checkDir(s.defaultWorkspace);
  }
  if (raw === '~' || raw.startsWith('~/')) return checkDir(resolve(homedir(), raw.slice(2)));
  if (isAbsolute(raw)) return checkDir(resolve(raw));
  const known = [...(s.workspaces ?? []), s.defaultWorkspace].filter(Boolean);
  const hit = known.find((w) => basename(w).toLowerCase() === raw.toLowerCase()) ?? known.find((w) => basename(w).toLowerCase().includes(raw.toLowerCase()));
  if (hit) return checkDir(hit);
  throw new Error(`Unknown workspace "${raw}". Give an absolute path, or one of: ${known.map((w) => basename(w)).join(', ') || '(none remembered)'}`);
}

function checkDir(p: string): string {
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`Workspace does not exist or is not a directory: ${p}`);
  return p;
}

async function codingSession(id: string) {
  const r = (await sess()).getSession(id);
  if (!r) throw new Error(`No session ${id}`);
  if (r.kind !== 'coding') throw new Error(`Session ${id} is a ${r.kind} session, not a worker agent`);
  return r;
}

async function assertNotNested(callerId: string): Promise<void> {
  const caller = (await sess()).getSession(callerId);
  if (caller?.kind === 'coding' && caller.parentSessionId) throw new Error('A delegated worker agent cannot start further worker agents.');
}

function toolLine(t: ToolItem): string {
  const inp = t.input && typeof t.input === 'object' ? (t.input as Record<string, unknown>) : {};
  const hint = ['file_path', 'path', 'command', 'pattern', 'url'].map((k) => inp[k]).find((v) => typeof v === 'string') as string | undefined;
  return `${t.name.replace(/^mcp__monarch__/, '')} [${t.status}]${hint ? ` ${clip(hint.replace(/\s+/g, ' '), 100)}` : ''}`;
}

function lastAssistant(items: ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'assistant' && it.text.trim()) return it.text;
  }
  return '';
}

export const UNEXECUTED_WARNING =
  'WARNING: the worker did not actually run any tools — nothing was changed; its reply contains unexecuted tool-call text.';
export const NO_TOOLS_NOTE =
  'NOTE: the worker ran no tools in its latest turn, so it did not create, edit or run anything — if the task needed changes, they were NOT made (whatever its reply says).';

/** tool names a worker could have meant (Monarch coding tools + Claude Code built-ins) */
async function workerToolNames(): Promise<string[]> {
  const t = await import('../agent/toolset.ts');
  return [...t.piToolDefs('coding').map((d) => d.name), ...t.SDK_CODING_BUILTINS];
}

/** the worker's latest turn ran no tools but its reply is tool-call text → nothing really happened */
async function unexecuted(toolCallsThisTurn: number, reply: string): Promise<boolean> {
  if (toolCallsThisTurn > 0 || !reply.trim()) return false;
  try {
    return looksLikeTextToolCall(reply, await workerToolNames());
  } catch {
    return false;
  }
}

async function statusOf(id: string, tail = 8) {
  const r = await codingSession(id);
  const o = await orch();
  const pend = (await appr()).pendingApprovals().filter((p) => p.sessionId === id);
  const items = r.items;
  const lastErr = [...items].reverse().find((i) => i.kind === 'error') as Extract<ChatItem, { kind: 'error' }> | undefined;
  const lastUserIdx = items.map((i) => i.kind).lastIndexOf('user');
  const errorThisTurn = lastErr && items.indexOf(lastErr) > lastUserIdx ? lastErr.message : undefined;
  const running = o.isSessionRunning(id);
  const state = pend.length ? 'awaiting-approval' : running ? 'running' : errorThisTurn ? 'error' : 'idle';
  const tools = items.filter((i): i is ToolItem => i.kind === 'tool');
  const toolCallsThisTurn = items.filter((i, idx): i is ToolItem => i.kind === 'tool' && idx > lastUserIdx && i.status !== 'error').length;
  const last = lastAssistant(items);
  const settled = state !== 'running' && lastUserIdx >= 0;
  const warn = settled && (await unexecuted(toolCallsThisTurn, last));
  const noTools = settled && !warn && toolCallsThisTurn === 0 && !errorThisTurn && !pend.length;
  return {
    sessionId: id,
    link: link(id),
    title: r.title,
    cwd: r.cwd,
    engine: r.engine,
    model: r.model,
    state,
    phase: o.sessionPhase(id),
    queuedFollowUps: o.queuedCount(id),
    error: errorThisTurn,
    pendingApprovals: pend.map((p) => ({ id: p.id, tool: p.tool, summary: p.summary })),
    ...(warn ? { warning: UNEXECUTED_WARNING } : noTools ? { warning: NO_TOOLS_NOTE } : {}),
    toolCalls: tools.length,
    toolCallsThisTurn,
    recentTools: tools.slice(-Math.max(0, tail)).map(toolLine),
    lastAssistant: clip(last, 4000),
    usage: r.usage,
    updatedAt: r.updatedAt,
  };
}

async function waitAndReport(id: string, timeoutSec: number, signal: AbortSignal, progress: (t: string) => void) {
  const o = await orch();
  const tick = setInterval(() => {
    void statusOf(id, 1)
      .then((s) => progress(`… ${s.state}${s.recentTools[0] ? ` · ${s.recentTools[0]}` : ''}${s.pendingApprovals.length ? ' · waiting for the user to approve' : ''}`))
      .catch(() => {});
  }, 10_000);
  try {
    const out = await o.waitForSessionIdle(id, timeoutSec * 1000, signal);
    const s = await statusOf(id, 12);
    if (out && s.warning !== UNEXECUTED_WARNING && (await unexecuted(s.toolCallsThisTurn, out.text || ''))) (s as typeof s & { warning?: string }).warning = UNEXECUTED_WARNING;
    return {
      finished: !!out,
      ...(out ? {} : { note: `Still ${s.state} after ${timeoutSec}s — call agent_wait again or agent_status later.` }),
      ...s,
      finalReply: out ? clip(out.text || s.lastAssistant, 6000) : undefined,
    };
  } finally {
    clearInterval(tick);
  }
}

/* ─────────────── compact (small-model) rendering ─────────────── */

type Status = Awaited<ReturnType<typeof statusOf>>;

function compactStatus(s: Status & { finished?: boolean; note?: string; finalReply?: string }): string {
  const lines = [`Worker agent ${s.sessionId} "${s.title}" — ${s.state}${s.finished === false ? ' (not finished yet)' : ''}`, `cwd: ${s.cwd ?? '?'} · model: ${s.model || s.engine}`];
  if (s.warning) lines.push(s.warning);
  lines.push(`toolCalls: ${s.toolCallsThisTurn} (executed, latest turn) · ${s.toolCalls} total`);
  if (s.error) lines.push(`error: ${clip(s.error, 300)}`);
  if (s.pendingApprovals.length) lines.push(`waiting for the user to approve: ${s.pendingApprovals.map((p) => p.summary).join('; ')}`);
  if (s.recentTools.length) lines.push(`recent tools: ${s.recentTools.slice(-5).join(', ')}`);
  const reply = s.finalReply || s.lastAssistant;
  if (reply) lines.push(`${s.finalReply ? 'final reply' : 'last reply'}: ${clip(reply.replace(/\s+/g, ' '), 1200)}`);
  if (s.note) lines.push(s.note);
  return lines.join('\n');
}

/**
 * Short list of recent worker agents for the manager's prompt: this chat's own agents first, then others.
 * One line each: id, title, cwd basename, state, model.
 */
export async function codingAgentsBrief(parentId: string, limit = 8): Promise<string> {
  const o = await orch();
  const S = await sess();
  const all = S.listSessions('coding');
  const mine = all.filter((x) => x.parentSessionId === parentId);
  const others = all.filter((x) => x.parentSessionId !== parentId);
  const pick = [...mine, ...others].slice(0, limit);
  if (!pick.length) return '';
  const lines: string[] = [];
  for (const x of pick) {
    let state = o.isSessionRunning(x.id) ? 'running' : 'idle';
    if (state === 'idle') {
      const r = S.getSession(x.id);
      const items = r?.items ?? [];
      const lastUser = items.map((i) => i.kind).lastIndexOf('user');
      if (items.some((i, idx) => i.kind === 'error' && idx > lastUser)) state = 'error';
    }
    lines.push(`- ${x.id} "${clip(x.title, 50)}" in ${x.cwd ? basename(x.cwd) : '?'} · ${state} · ${x.model || x.engine}${x.parentSessionId === parentId ? '' : ' · (not from this chat)'}`);
  }
  return lines.join('\n');
}

const KEYWORDS = ['worker', 'agent', 'delegate', 'workshop', 'coding', 'code', 'implement', 'fix bug', 'refactor', 'research', 'triage', 'inbox', 'plan', 'draft', 'sub-agent', 'project'];
const common = { group: 'worker-agents', keywords: KEYWORDS, tag: 'CODE' as const };

/** default runtime/model for worker agents (Config → Models → Worker agents); falls back to the user's default */
function workerDefault(): { engine?: EngineId; model?: string } {
  const w = (getSettings() as { agent?: { workerModel?: { engine?: EngineId; model?: string } } }).agent?.workerModel;
  return w?.model ? { engine: w.engine, model: w.model } : {};
}

export const tools: ToolDef[] = [
  defineTool({
    ...common,
    name: 'agent_start',
    description:
      'Delegate a task to a new worker agent (a Workshop session with every Monarch tool — mail, calendar, Slack, tasks, memory, web — plus file/shell tools in a folder). ' +
      'Use it for heavy or long work: any code change or inspection; thorough inbox/Slack triage across accounts; research and write-ups; planning; long drafts. Do quick actions and lookups yourself instead. ' +
      'Returns sessionId and a Workshop link immediately (wait=false), or blocks until the agent finishes (wait=true). Give a complete, self-contained task and the expected output. ' +
      'cwd: project folder for code work (absolute path or remembered workspace name; default workspace if omitted); not needed for non-code tasks. ' +
      'Runtime/model: omit both to use the worker default from Config (usually a stronger model than yours). Only pick one when the user asks; agent_models lists what is available.',
    risk: 'sensitive',
    loading: 'always',
    schema: z.object({
      task: z.string().min(1).describe('full, self-contained instructions and the expected result'),
      cwd: z.string().optional().describe('project folder for code work: absolute path, ~/path, or remembered workspace name. Omit for non-code tasks.'),
      title: z.string().optional(),
      engine: z
        .enum(['claude-sdk', 'pi'])
        .optional()
        .describe("runtime: 'claude-sdk' = Claude Code on the user's Claude subscription; 'pi' = any pi provider (OpenAI, Gemini, OpenRouter, custom…). Default: the user's default engine."),
      model: z
        .string()
        .optional()
        .describe("claude-sdk: an alias (opus, sonnet, haiku) or a full Claude model id. pi: '<provider>/<model-id>' as listed by agent_models. A '/' implies engine pi."),
      wait: z.boolean().optional().describe('block until the agent finishes its turn (default false; true in small-model mode)'),
      timeoutSec: z.number().int().min(5).max(1800).optional().describe('when wait=true (default 300)'),
    }),
    summarize: (i) => `Start worker agent${i.cwd ? ` in ${i.cwd}` : ''}: ${clip(i.task, 120)}`,
    async run(i, ctx) {
      await assertNotNested(ctx.sessionId);
      // code work needs a real folder; other tasks fall back to the default workspace or home
      let cwd: string;
      try {
        cwd = resolveWorkspace(i.cwd);
      } catch (e) {
        if (i.cwd) throw e;
        cwd = homedir();
      }
      const o = await orch();
      const title = i.title?.trim() || clip(i.task.replace(/\s+/g, ' '), 60);
      const def = !i.engine && !i.model ? workerDefault() : {};
      const choice = await validateModel((i.engine ?? def.engine) as EngineId | undefined, i.model ?? def.model);
      const { sessionId } = o.startPrompt({
        text: i.task,
        kind: 'coding',
        title,
        engine: choice.engine,
        model: choice.model,
        cwd,
        parentSessionId: ctx.sessionId,
      });
      if (i.wait ?? ctx.small) {
        const r = await waitAndReport(sessionId, i.timeoutSec ?? 300, ctx.signal, ctx.progress);
        return ctx.small ? `Started worker agent ${sessionId}.\n${compactStatus(r)}` : r;
      }
      if (ctx.small) return `Started worker agent ${sessionId} "${title}" in ${cwd}. It is running in the background; follow it with agent_wait {"sessionId": "${sessionId}"}.`;
      return { sessionId, link: link(sessionId), cwd, title, state: 'running', note: 'Running in the background. Use agent_wait or agent_status to follow it.' };
    },
  }),
  defineTool({
    ...common,
    name: 'agent_send',
    description:
      'Send a follow-up instruction to an existing worker agent session. Starts a new turn if idle; queued after the current turn if it is busy. ' +
      'Optional model switches that agent to another model of the SAME runtime from this message on (e.g. escalate to opus for a hard bug); a different runtime needs a new agent.',
    risk: 'sensitive',
    schema: z.object({
      sessionId: z.string(),
      message: z.string().min(1),
      model: z.string().optional().describe('switch to this model (same runtime) before sending; see agent_models'),
    }),
    summarize: (i) => `Tell worker agent ${i.sessionId.slice(0, 8)}: ${clip(i.message, 120)}`,
    async run(i, ctx) {
      const rec = await codingSession(i.sessionId);
      let switched: string | undefined;
      if (i.model?.trim()) {
        const choice = await validateModel(rec.engine, i.model);
        const now = (await orch()).setSessionModel(i.sessionId, rec.engine, choice.model!);
        switched = `model now ${now}`;
      }
      const r = (await orch()).sendToSession(i.sessionId, i.message);
      if (ctx.small) return `Sent to worker agent ${i.sessionId}: ${r === 'queued' ? 'it is busy, message queued for after its current turn' : 'turn started'}${switched ? ` (${switched})` : ''}. Use agent_wait {"sessionId": "${i.sessionId}"} to get the result.`;
      return { sessionId: i.sessionId, link: link(i.sessionId), result: r, ...(switched ? { switched } : {}), note: r === 'queued' ? 'Agent is busy; message queued and will run after the current turn.' : 'Turn started.' };
    },
  }),
  defineTool({
    ...common,
    name: 'agent_status',
    description: 'State of a worker agent session: running/idle/error/awaiting-approval, last assistant message, recent tool calls, pending approvals, usage.',
    risk: 'safe',
    loading: 'always',
    schema: z.object({ sessionId: z.string(), tail: z.number().int().min(0).max(50).optional().describe('number of recent tool calls (default 8)') }),
    summarize: (i) => `Worker agent status ${i.sessionId.slice(0, 8)}`,
    run: async (i, ctx) => {
      const st = await statusOf(i.sessionId, i.tail ?? 8);
      return ctx.small ? compactStatus(st) : st;
    },
  }),
  defineTool({
    ...common,
    name: 'agent_wait',
    description: "Block until a worker agent finishes its current work (or timeout) and return its final reply plus status — use it to review the agent's result. " +
      'Verify: only report work as done if the worker actually executed tools / the result shows it.',
    risk: 'safe',
    schema: z.object({ sessionId: z.string(), timeoutSec: z.number().int().min(1).max(1800).optional().describe('default 300') }),
    summarize: (i) => `Wait for worker agent ${i.sessionId.slice(0, 8)}`,
    async run(i, ctx) {
      await codingSession(i.sessionId);
      const r = await waitAndReport(i.sessionId, i.timeoutSec ?? 300, ctx.signal, ctx.progress);
      return ctx.small ? compactStatus(r) : r;
    },
  }),
  defineTool({
    ...common,
    name: 'agent_list',
    description: 'List recent worker agent (Workshop) sessions with their state, newest first.',
    risk: 'safe',
    schema: z.object({ limit: z.number().int().min(1).max(50).optional(), mine: z.boolean().optional().describe('only sessions delegated from this chat') }),
    async run(i, ctx) {
      const o = await orch();
      let list = (await sess()).listSessions('coding');
      if (i.mine) list = list.filter((s) => s.parentSessionId === ctx.sessionId);
      if (ctx.small) {
        const pick = list.slice(0, i.limit ?? 15);
        return pick.length
          ? pick.map((s) => `- ${s.id} "${clip(s.title, 50)}" in ${s.cwd ? basename(s.cwd) : '?'} · ${o.isSessionRunning(s.id) ? 'running' : 'idle'}${s.parentSessionId === ctx.sessionId ? ' · from this chat' : ''}`).join('\n')
          : 'No worker agents yet.';
      }
      return list.slice(0, i.limit ?? 15).map((s) => ({
        sessionId: s.id,
        title: s.title,
        cwd: s.cwd,
        state: o.isSessionRunning(s.id) ? 'running' : 'idle',
        delegatedFromHere: s.parentSessionId === ctx.sessionId,
        updatedAt: s.updatedAt,
        link: link(s.id),
      }));
    },
  }),
  defineTool({
    ...common,
    name: 'agent_abort',
    description: 'Stop a worker agent: abort its running turn and drop queued follow-ups.',
    risk: 'sensitive',
    schema: z.object({ sessionId: z.string() }),
    summarize: (i) => `Stop worker agent ${i.sessionId.slice(0, 8)}`,
    async run(i) {
      await codingSession(i.sessionId);
      const stopped = (await orch()).abortSession(i.sessionId);
      return { sessionId: i.sessionId, stopped, note: stopped ? 'Stopped.' : 'Was not running.' };
    },
  }),
  defineTool({
    ...common,
    name: 'agent_models',
    description:
      'List the runtimes and models a worker agent can use (every model of every provider the user has configured). Use the spec values as agent_start/agent_send `model`.',
    risk: 'safe',
    schema: z.object({ query: z.string().optional().describe('optional filter, e.g. "opus", "gpt", "gemini"') }),
    summarize: (i) => `List worker agent models${i.query ? ` matching ${i.query}` : ''}`,
    async run(i) {
      const s = getSettings();
      const q = i.query?.trim().toLowerCase();
      const all = (await availableModels()).filter((m) => !q || `${m.spec} ${m.name}`.toLowerCase().includes(q));
      const def = s.engine === 'pi' ? `pi ${s.pi.provider}/${s.pi.model}` : `claude-sdk ${s.claudeSdk.model}`;
      const lines = [`Default (used when engine/model are omitted): ${def}`];
      for (const eng of ['claude-sdk', 'pi'] as EngineId[]) {
        const ms = all.filter((m) => m.engine === eng);
        if (!ms.length) continue;
        lines.push('', eng === 'claude-sdk' ? 'claude-sdk (Claude subscription) — aliases: opus, sonnet, haiku' : 'pi');
        for (const m of ms.slice(0, 80)) lines.push(`- ${m.spec} — ${m.name}${m.context ? ` · ${Math.round(m.context / 1000)}k ctx` : ''}${m.reasoning ? ' · reasoning' : ''}`);
        if (ms.length > 80) lines.push(`… ${ms.length - 80} more (use query to filter)`);
      }
      if (all.length === 0) lines.push(q ? `No models match "${i.query}".` : 'No configured providers found.');
      return lines.join('\n');
    },
  }),
];

/** legacy names (sessions and habits from before 0.7.0): same tools, deferred and hidden from the prompt */
for (const t of [...tools]) {
  tools.push({ ...t, name: `coding_${t.name}`, loading: 'deferred', description: `Legacy alias of ${t.name}. ${t.description}` } as ToolDef);
}
