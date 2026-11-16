/**
 * Coding agents (group 'coding-agents'): lets a chat agent delegate work to a Workshop coding session and
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

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const orch = () => import('../agent/orchestrator.ts');
const sess = () => import('../agent/sessions.ts');
const appr = () => import('../agent/approvals.ts');

/* ─────────────── model selection ─────────────── */

const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];

/** every model of every configured provider, as the specs coding_agent_start accepts */
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
      (close.length ? ` Close matches: ${close.join(', ')}.` : ` Call coding_agent_models to see the models you can use.`) +
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
  if (r.kind !== 'coding') throw new Error(`Session ${id} is a ${r.kind} session, not a coding agent`);
  return r;
}

async function assertNotNested(callerId: string): Promise<void> {
  const caller = (await sess()).getSession(callerId);
  if (caller?.kind === 'coding' && caller.parentSessionId) throw new Error('A delegated coding agent cannot start further coding agents.');
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
    toolCalls: tools.length,
    recentTools: tools.slice(-Math.max(0, tail)).map(toolLine),
    lastAssistant: clip(lastAssistant(items), 4000),
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
    return {
      finished: !!out,
      ...(out ? {} : { note: `Still ${s.state} after ${timeoutSec}s — call coding_agent_wait again or coding_agent_status later.` }),
      ...s,
      finalReply: out ? clip(out.text || s.lastAssistant, 6000) : undefined,
    };
  } finally {
    clearInterval(tick);
  }
}

const KEYWORDS = ['coding', 'code', 'delegate', 'workshop', 'implement', 'fix bug', 'refactor', 'programming', 'sub-agent', 'developer', 'repository', 'project'];
const common = { group: 'coding-agents', keywords: KEYWORDS, tag: 'CODE' as const };

export const tools: ToolDef[] = [
  defineTool({
    ...common,
    name: 'coding_agent_start',
    description:
      'Delegate a coding task to a new coding agent (a Workshop session with file/shell tools in a workspace). Use this for any request to write, change, fix, refactor or inspect code instead of doing it inline. ' +
      'Returns sessionId and a Workshop link immediately (wait=false), or blocks until the agent finishes (wait=true). Give a complete, self-contained task description. ' +
      'cwd: absolute path or remembered workspace name; defaults to the default workspace. ' +
      'Runtime/model: omit both to use the user\'s default. Only pick a model when the user asks for one (e.g. "use opus") or the task clearly needs a stronger/cheaper model; ' +
      'call coding_agent_models to see what is available. The choice is validated before the session starts.',
    risk: 'sensitive',
    loading: 'always',
    schema: z.object({
      task: z.string().min(1).describe('full instructions for the coding agent'),
      cwd: z.string().optional().describe('workspace: absolute path, ~/path, or remembered workspace name'),
      title: z.string().optional(),
      engine: z
        .enum(['claude-sdk', 'pi'])
        .optional()
        .describe("runtime: 'claude-sdk' = Claude Code on the user's Claude subscription; 'pi' = any pi provider (OpenAI, Gemini, OpenRouter, custom…). Default: the user's default engine."),
      model: z
        .string()
        .optional()
        .describe("claude-sdk: an alias (opus, sonnet, haiku) or a full Claude model id. pi: '<provider>/<model-id>' as listed by coding_agent_models. A '/' implies engine pi."),
      wait: z.boolean().optional().describe('block until the agent finishes its turn (default false)'),
      timeoutSec: z.number().int().min(5).max(1800).optional().describe('when wait=true (default 300)'),
    }),
    summarize: (i) => `Start coding agent in ${i.cwd || 'default workspace'}: ${clip(i.task, 120)}`,
    async run(i, ctx) {
      await assertNotNested(ctx.sessionId);
      const cwd = resolveWorkspace(i.cwd);
      const o = await orch();
      const title = i.title?.trim() || clip(i.task.replace(/\s+/g, ' '), 60);
      const choice = await validateModel(i.engine as EngineId | undefined, i.model);
      const { sessionId } = o.startPrompt({
        text: i.task,
        kind: 'coding',
        title,
        engine: choice.engine,
        model: choice.model,
        cwd,
        parentSessionId: ctx.sessionId,
      });
      if (i.wait) return waitAndReport(sessionId, i.timeoutSec ?? 300, ctx.signal, ctx.progress);
      return { sessionId, link: link(sessionId), cwd, title, state: 'running', note: 'Running in the background. Use coding_agent_wait or coding_agent_status to follow it.' };
    },
  }),
  defineTool({
    ...common,
    name: 'coding_agent_send',
    description:
      'Send a follow-up instruction to an existing coding agent session. Starts a new turn if idle; queued after the current turn if it is busy. ' +
      'Optional model switches that agent to another model of the SAME runtime from this message on (e.g. escalate to opus for a hard bug); a different runtime needs a new agent.',
    risk: 'sensitive',
    schema: z.object({
      sessionId: z.string(),
      message: z.string().min(1),
      model: z.string().optional().describe('switch to this model (same runtime) before sending; see coding_agent_models'),
    }),
    summarize: (i) => `Tell coding agent ${i.sessionId.slice(0, 8)}: ${clip(i.message, 120)}`,
    async run(i) {
      const rec = await codingSession(i.sessionId);
      let switched: string | undefined;
      if (i.model?.trim()) {
        const choice = await validateModel(rec.engine, i.model);
        const now = (await orch()).setSessionModel(i.sessionId, rec.engine, choice.model!);
        switched = `model now ${now}`;
      }
      const r = (await orch()).sendToSession(i.sessionId, i.message);
      return { sessionId: i.sessionId, link: link(i.sessionId), result: r, ...(switched ? { switched } : {}), note: r === 'queued' ? 'Agent is busy; message queued and will run after the current turn.' : 'Turn started.' };
    },
  }),
  defineTool({
    ...common,
    name: 'coding_agent_status',
    description: 'State of a coding agent session: running/idle/error/awaiting-approval, last assistant message, recent tool calls, pending approvals, usage.',
    risk: 'safe',
    loading: 'always',
    schema: z.object({ sessionId: z.string(), tail: z.number().int().min(0).max(50).optional().describe('number of recent tool calls (default 8)') }),
    summarize: (i) => `Coding agent status ${i.sessionId.slice(0, 8)}`,
    run: (i) => statusOf(i.sessionId, i.tail ?? 8),
  }),
  defineTool({
    ...common,
    name: 'coding_agent_wait',
    description: "Block until a coding agent finishes its current work (or timeout) and return its final reply plus status — use it to review the agent's result.",
    risk: 'safe',
    schema: z.object({ sessionId: z.string(), timeoutSec: z.number().int().min(1).max(1800).optional().describe('default 300') }),
    summarize: (i) => `Wait for coding agent ${i.sessionId.slice(0, 8)}`,
    async run(i, ctx) {
      await codingSession(i.sessionId);
      return waitAndReport(i.sessionId, i.timeoutSec ?? 300, ctx.signal, ctx.progress);
    },
  }),
  defineTool({
    ...common,
    name: 'coding_agent_list',
    description: 'List recent coding agent (Workshop) sessions with their state, newest first.',
    risk: 'safe',
    schema: z.object({ limit: z.number().int().min(1).max(50).optional(), mine: z.boolean().optional().describe('only sessions delegated from this chat') }),
    async run(i, ctx) {
      const o = await orch();
      let list = (await sess()).listSessions('coding');
      if (i.mine) list = list.filter((s) => s.parentSessionId === ctx.sessionId);
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
    name: 'coding_agent_abort',
    description: 'Stop a coding agent: abort its running turn and drop queued follow-ups.',
    risk: 'sensitive',
    schema: z.object({ sessionId: z.string() }),
    summarize: (i) => `Stop coding agent ${i.sessionId.slice(0, 8)}`,
    async run(i) {
      await codingSession(i.sessionId);
      const stopped = (await orch()).abortSession(i.sessionId);
      return { sessionId: i.sessionId, stopped, note: stopped ? 'Stopped.' : 'Was not running.' };
    },
  }),
  defineTool({
    ...common,
    name: 'coding_agent_models',
    description:
      'List the runtimes and models a coding agent can use (every model of every provider the user has configured). Use the spec values as coding_agent_start/coding_agent_send `model`.',
    risk: 'safe',
    schema: z.object({ query: z.string().optional().describe('optional filter, e.g. "opus", "gpt", "gemini"') }),
    summarize: (i) => `List coding agent models${i.query ? ` matching ${i.query}` : ''}`,
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
