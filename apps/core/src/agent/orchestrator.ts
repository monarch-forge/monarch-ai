/**
 * Agent orchestrator (Core-B). Contract exports: handleClientCommand, runPrompt, currentPhase, initAgent.
 *
 * Turns engine events (engines/types.ts) into ChatItems + ServerEvents, enforces one turn at a time
 * per session (extra messages queue as follow-ups), routes tool approvals, tracks usage and phases.
 */
import type { AgentPhase, ChatItem, ClientCommand, EngineId, SessionKind, Usage } from '@monarch/shared';
import { activity, bus, newId, notify, nowIso, truncate } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { recordUsage } from '../services/usage.ts';
import { spawn } from 'node:child_process';
import { getRepoProfile, repoTarget } from '../services/projects.ts';
import { autoMode, needsApproval, rejectSessionApprovals, requestApproval, respondApproval, clearSessionAllowances, type ApprovalScope } from './approvals.ts';
import { findTool } from '../tools/index.ts';
import { maybeLearn } from './profile-learn.ts';
import { resolve } from 'node:path';
import {
  addUsage,
  autoTitle,
  broadcastSession,
  createSession,
  deleteSession,
  emptyUsage,
  flushSessions,
  getSession,
  listSessions,
  saveSession,
  touch,
  type SessionRecord,
} from './sessions.ts';
import { buildSystemPrompt } from './prompt.ts';
import { clip, errorText } from './toolset.ts';
import type { ApprovalAsk, Engine, EngineEvent, TurnContext, TurnResult } from './engines/types.ts';
import { claudeSdkEngine } from './engines/claude-sdk.ts';
import { piEngine } from './engines/pi.ts';
import { resolvePiModel } from './pi-models.ts';

type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>;
type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

interface TurnOutcome {
  text: string;
  error?: string;
}

interface ActiveTurn {
  rec: SessionRecord;
  abort: AbortController;
  phase: AgentPhase;
  startedAt: number;
  assistant: AssistantItem | null;
  model?: string;
  tools: Map<string, ToolItem>;
  toolStartedAt: Map<string, number>;
  progressTimers: Map<string, NodeJS.Timeout>;
  texts: string[];
}

const engines: Record<EngineId, Engine> = { 'claude-sdk': claudeSdkEngine, pi: piEngine };
const active = new Map<string, ActiveTurn>();
const queued = new Map<string, string[]>();
/** resolvers waiting for a session to go idle (turn finished and no queued follow-ups) — see waitForSessionIdle */
const idleWaiters = new Map<string, Set<(o: TurnOutcome) => void>>();
/** session ids ordered by most recent phase change (last = most recent) */
const phaseRecency: string[] = [];
let idleTimer: NodeJS.Timeout | null = null;

/* ─────────────── phases ─────────────── */

function setPhase(turn: ActiveTurn, phase: AgentPhase, detail?: string): void {
  if (turn.phase === phase && !detail) return;
  turn.phase = phase;
  const i = phaseRecency.indexOf(turn.rec.id);
  if (i >= 0) phaseRecency.splice(i, 1);
  phaseRecency.push(turn.rec.id);
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  bus.broadcast({ type: 'agent.phase', phase, sessionId: turn.rec.id, detail });
}

export function currentPhase(): AgentPhase {
  for (let i = phaseRecency.length - 1; i >= 0; i--) {
    const t = active.get(phaseRecency[i]);
    if (t) return t.phase;
  }
  return 'idle';
}

function afterTurnPhase(sessionId: string, error?: string): void {
  const i = phaseRecency.indexOf(sessionId);
  if (i >= 0) phaseRecency.splice(i, 1);
  for (let j = phaseRecency.length - 1; j >= 0; j--) {
    const t = active.get(phaseRecency[j]);
    if (t) {
      bus.broadcast({ type: 'agent.phase', phase: t.phase, sessionId: t.rec.id });
      return;
    }
  }
  if (error && error !== 'aborted') {
    bus.broadcast({ type: 'agent.phase', phase: 'error', sessionId, detail: clip(error, 160) });
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!active.size) bus.broadcast({ type: 'agent.phase', phase: 'idle' });
    }, 4000);
    idleTimer.unref?.();
  } else {
    bus.broadcast({ type: 'agent.phase', phase: 'idle', sessionId });
  }
}

/* ─────────────── items ─────────────── */

function pushItem(rec: SessionRecord, item: ChatItem): void {
  rec.items.push(item);
  touch(rec);
  saveSession(rec);
  bus.broadcast({ type: 'chat.item', sessionId: rec.id, item });
}

function updateItem(rec: SessionRecord, item: ChatItem): void {
  saveSession(rec);
  bus.broadcast({ type: 'chat.item.update', sessionId: rec.id, item });
}

function appendUser(rec: SessionRecord, text: string): void {
  const first = !rec.items.some((i) => i.kind === 'user');
  pushItem(rec, { kind: 'user', id: newId(), ts: nowIso(), text });
  if (first && (rec.title === 'New session' || !rec.title)) {
    rec.title = autoTitle(text);
    saveSession(rec);
  }
  broadcastSession(rec);
}

function closeAssistant(turn: ActiveTurn): void {
  const a = turn.assistant;
  if (!a) return;
  turn.assistant = null;
  a.streaming = false;
  if (a.text.trim()) turn.texts.push(a.text);
  updateItem(turn.rec, a);
}

function ensureAssistant(turn: ActiveTurn): AssistantItem {
  if (turn.assistant) return turn.assistant;
  const a: AssistantItem = { kind: 'assistant', id: newId(), ts: nowIso(), text: '', model: turn.model, streaming: true };
  turn.assistant = a;
  pushItem(turn.rec, a);
  return a;
}

function toolStart(turn: ActiveTurn, ev: Extract<EngineEvent, { type: 'tool-start' }>): ToolItem {
  const existing = turn.tools.get(ev.callId);
  if (existing) {
    let changed = false;
    if (ev.input !== undefined && JSON.stringify(ev.input) !== JSON.stringify(existing.input)) {
      existing.input = ev.input;
      changed = true;
    }
    if (ev.risk && existing.risk !== ev.risk) {
      existing.risk = ev.risk;
      changed = true;
    }
    if (changed) updateItem(turn.rec, existing);
    return existing;
  }
  closeAssistant(turn);
  const item: ToolItem = {
    kind: 'tool',
    id: newId(),
    ts: nowIso(),
    toolCallId: ev.callId,
    name: ev.name,
    input: ev.input,
    status: 'running',
    risk: ev.risk,
  };
  turn.tools.set(ev.callId, item);
  turn.toolStartedAt.set(ev.callId, Date.now());
  pushItem(turn.rec, item);
  setPhase(turn, 'tool', ev.name);
  return item;
}

function onEngineEvent(turn: ActiveTurn, ev: EngineEvent): void {
  if (!active.has(turn.rec.id) || active.get(turn.rec.id) !== turn) return; // stale turn
  switch (ev.type) {
    case 'text': {
      const a = ensureAssistant(turn);
      a.text += ev.delta;
      saveSession(turn.rec);
      bus.broadcast({ type: 'chat.delta', sessionId: turn.rec.id, itemId: a.id, text: ev.delta });
      if (turn.phase !== 'responding') setPhase(turn, 'responding');
      break;
    }
    case 'thinking': {
      const a = ensureAssistant(turn);
      a.thinking = (a.thinking ?? '') + ev.delta;
      saveSession(turn.rec);
      bus.broadcast({ type: 'chat.delta', sessionId: turn.rec.id, itemId: a.id, thinking: ev.delta });
      if (turn.phase !== 'thinking') setPhase(turn, 'thinking');
      break;
    }
    case 'assistant-end':
      closeAssistant(turn);
      break;
    case 'model':
      turn.model = ev.model;
      if (turn.assistant && !turn.assistant.model) turn.assistant.model = ev.model;
      break;
    case 'tool-start':
      toolStart(turn, ev);
      break;
    case 'tool-running': {
      const t = turn.tools.get(ev.callId);
      if (t && t.status !== 'running') {
        t.status = 'running';
        updateItem(turn.rec, t);
      }
      break;
    }
    case 'tool-end': {
      const t = turn.tools.get(ev.callId);
      if (!t) break;
      const timer = turn.progressTimers.get(ev.callId);
      if (timer) {
        clearTimeout(timer);
        turn.progressTimers.delete(ev.callId);
      }
      t.status = t.status === 'denied' ? 'denied' : ev.ok ? 'ok' : 'error';
      t.output = truncate(ev.output ?? '', 8000);
      t.durationMs = ev.durationMs ?? Date.now() - (turn.toolStartedAt.get(ev.callId) ?? Date.now());
      updateItem(turn.rec, t);
      setPhase(turn, 'thinking');
      break;
    }
    case 'phase':
      setPhase(turn, ev.phase, ev.detail);
      break;
    case 'context':
      setContext(turn.rec, ev.used, ev.window);
      break;
    case 'compacted': {
      const rec = turn.rec;
      maybeLearn(rec, true); // reads the UI transcript, which compaction keeps
      const prev = rec.context;
      rec.context = { ...(prev ?? { used: 0, window: 0, percent: 0, compactions: 0 }), compactions: (prev?.compactions ?? 0) + 1, lastCompactedAt: nowIso() };
      if (ev.post !== undefined) setContext(rec, ev.post);
      closeAssistant(turn);
      const how = ev.trigger === 'auto' ? 'auto' : 'manual';
      const text = ev.post !== undefined && ev.pre ? `Context compacted (${how}): ${fmtTokens(ev.pre)} → ${fmtTokens(ev.post)} tokens` : ev.pre ? `Context compacted (${how}) from ${fmtTokens(ev.pre)} tokens` : `Context compacted (${how})`;
      pushItem(rec, { kind: 'system', id: newId(), ts: nowIso(), text });
      broadcastSession(rec);
      activity(rec.kind === 'coding' ? 'CODE' : 'AGT', `${text} · ${clip(rec.title, 40)}`, 'info', rec.id);
      break;
    }
  }
}

/** update the session's context meter (window kept from earlier turns when the engine doesn't know it) */
function setContext(rec: SessionRecord, used: number, window?: number): void {
  const prev = rec.context;
  const win = window && window > 0 ? window : prev?.window || 0;
  const percent = win ? Math.round((used / win) * 1000) / 10 : 0;
  if (prev && prev.used === used && prev.window === win) return;
  rec.context = { used, window: win, percent, compactions: prev?.compactions ?? 0, ...(prev?.lastCompactedAt ? { lastCompactedAt: prev.lastCompactedAt } : {}) };
  saveSession(rec);
  broadcastSession(rec);
}

function toolProgress(turn: ActiveTurn, callId: string | undefined, name: string, text: string): void {
  let item = callId ? turn.tools.get(callId) : undefined;
  if (!item) {
    for (const t of [...turn.tools.values()].reverse()) {
      if (t.name === name && t.status === 'running') {
        item = t;
        break;
      }
    }
  }
  if (!item) return;
  const target = item;
  target.output = truncate(`${target.output ?? ''}${text.endsWith('\n') ? text : `${text}\n`}`.slice(-8000), 8000);
  if (turn.progressTimers.has(target.toolCallId)) return;
  turn.progressTimers.set(
    target.toolCallId,
    setTimeout(() => {
      turn.progressTimers.delete(target.toolCallId);
      updateItem(turn.rec, target);
    }, 150),
  );
}

/** auto-mode scope of a call: Monarch tools via ToolDef.target/bulkCount, Claude Code built-ins by repo */
function approvalScope(turn: ActiveTurn, ask: ApprovalAsk): ApprovalScope {
  const cwd = effectiveCwd(turn.rec);
  const input = (ask.input ?? {}) as Record<string, unknown>;
  const def = findTool(ask.name);
  try {
    if (def) return { target: def.target?.(input, cwd), bulk: def.bulkCount?.(input) };
    if (ask.name === 'Bash') return { target: repoTarget(cwd) };
    if (typeof input.file_path === 'string') return { target: repoTarget(resolve(cwd, input.file_path)) };
  } catch {
    /* malformed input: fall back to the plain policy */
  }
  return {};
}

async function approve(turn: ActiveTurn, ask: ApprovalAsk): Promise<boolean> {
  const scope = approvalScope(turn, ask);
  if (!needsApproval(turn.rec.id, ask.name, ask.risk, scope)) return true;
  const item = toolStart(turn, { type: 'tool-start', callId: ask.callId, name: ask.name, input: ask.input, risk: ask.risk });
  item.status = 'pending-approval';
  updateItem(turn.rec, item);
  setPhase(turn, 'awaiting-approval', ask.summary);
  const ok = await requestApproval(turn.rec.id, ask.name, ask.input, ask.risk, ask.summary, turn.abort.signal, scope);
  item.status = ok ? 'running' : 'denied';
  if (!ok) item.output = 'Denied by user';
  updateItem(turn.rec, item);
  if (active.get(turn.rec.id) === turn) setPhase(turn, ok ? 'tool' : 'thinking');
  activity(turn.rec.kind === 'coding' ? 'CODE' : 'AGT', `${ok ? 'Approved' : 'Denied'}: ${clip(ask.summary, 100)}`, ok ? 'info' : 'warn', turn.rec.id);
  return ok;
}

/* ─────────────── turns ─────────────── */

function effectiveCwd(rec: SessionRecord): string {
  return rec.cwd || getSettings().coding.defaultWorkspace;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

async function startTurn(rec: SessionRecord, text: string, mode: 'turn' | 'compact' = 'turn'): Promise<TurnOutcome> {
  const turn: ActiveTurn = {
    rec,
    abort: new AbortController(),
    phase: 'idle',
    startedAt: Date.now(),
    assistant: null,
    tools: new Map(),
    toolStartedAt: new Map(),
    progressTimers: new Map(),
    texts: [],
  };
  active.set(rec.id, turn);
  rec.running = true;
  touch(rec);
  saveSession(rec);
  broadcastSession(rec);
  setPhase(turn, 'thinking', mode === 'compact' ? 'Compacting context' : undefined);
  const tag = rec.kind === 'coding' ? 'CODE' : 'AGT';
  activity(tag, `${mode === 'compact' ? 'Compaction' : rec.kind === 'automation' ? 'Automation' : 'Turn'} started · ${clip(rec.title, 60)}`, 'info', rec.id);

  let result: TurnResult;
  try {
    const engine = engines[rec.engine] ?? engines['claude-sdk'];
    const cwd = effectiveCwd(rec);
    const systemPrompt = await buildSystemPrompt({ kind: rec.kind, cwd, engine: engine.id, sessionId: rec.id, model: rec.model, piProvider: rec.engineState.piProvider });
    const ctx: TurnContext = {
      session: rec,
      text,
      systemPrompt,
      cwd,
      signal: turn.abort.signal,
      emit: (ev) => onEngineEvent(turn, ev),
      approve: (ask) => approve(turn, ask),
      progress: (callId, name, t) => toolProgress(turn, callId, name, t),
      save: () => saveSession(rec),
    };
    if (mode === 'compact') {
      result = engine.compact ? await engine.compact(ctx) : { usage: emptyUsage(), error: 'This engine cannot compact.' };
    } else {
      result = await engine.runTurn(ctx);
    }
  } catch (e) {
    result = { usage: emptyUsage(), error: errorText(e) };
  }
  return finishTurn(turn, result);
}

function finishTurn(turn: ActiveTurn, result: TurnResult): TurnOutcome {
  const rec = turn.rec;
  const aborted = turn.abort.signal.aborted || result.error === 'aborted';
  closeAssistant(turn);
  for (const [id, timer] of turn.progressTimers) {
    clearTimeout(timer);
    turn.progressTimers.delete(id);
  }
  for (const t of turn.tools.values()) {
    if (t.status === 'running' || t.status === 'pending-approval') {
      t.status = 'error';
      t.output = t.output ? `${t.output}\n[${aborted ? 'aborted' : 'interrupted'}]` : aborted ? 'aborted' : 'interrupted';
      updateItem(rec, t);
    }
  }

  const usage: Usage = result.usage ?? emptyUsage();
  rec.usage = addUsage(rec.usage, usage);
  const model = result.model || turn.model || rec.model;
  try {
    if (result.byModel && Object.keys(result.byModel).length) {
      for (const [m, u] of Object.entries(result.byModel)) if (u.inputTokens || u.outputTokens) recordUsage(m, u);
    } else if (usage.inputTokens || usage.outputTokens) {
      recordUsage(model, usage);
    }
  } catch (e) {
    console.error('[agent] recordUsage failed', e);
  }

  let error = result.error;
  if (aborted) {
    error = 'aborted';
    pushItem(rec, { kind: 'system', id: newId(), ts: nowIso(), text: 'Stopped.' });
  } else if (error) {
    pushItem(rec, { kind: 'error', id: newId(), ts: nowIso(), message: error });
  }

  const durationMs = Date.now() - turn.startedAt;
  active.delete(rec.id);
  rec.running = false;
  touch(rec);
  saveSession(rec);
  bus.broadcast({ type: 'chat.done', sessionId: rec.id, usage, durationMs, error });
  broadcastSession(rec);
  if (!error) maybeLearn(rec);

  const tag = rec.kind === 'coding' ? 'CODE' : 'AGT';
  const tokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const cost = usage.costUsd ? ` · $${usage.costUsd.toFixed(4)}` : '';
  if (error && !aborted) activity(tag === 'CODE' ? 'CODE' : 'ERR', `Turn failed · ${clip(error, 120)}`, 'error', rec.id);
  else activity(tag, `${aborted ? 'Stopped' : 'Done'} · ${clip(rec.title, 40)} · ${fmtTokens(tokens)} tok${cost} · ${(durationMs / 1000).toFixed(1)}s`, 'info', rec.id);

  afterTurnPhase(rec.id, error);

  // follow-ups queued while this turn ran
  const q = queued.get(rec.id);
  if (q?.length && !aborted) {
    const next = q.shift()!;
    if (!q.length) queued.delete(rec.id);
    setImmediate(() => {
      const cur = getSession(rec.id);
      if (!cur || active.has(cur.id)) return;
      appendUser(cur, next);
      void startTurn(cur, next);
    });
  } else {
    queued.delete(rec.id);
  }

  const text = turn.texts.length ? turn.texts[turn.texts.length - 1] : '';
  const moreQueued = !aborted && !!q?.length;
  if (!moreQueued && !aborted && !error && rec.kind === 'coding' && [...turn.tools.values()].some((t) => EDIT_TOOLS.test(t.name))) {
    checking.add(rec.id);
    void runCheck(rec, text).finally(() => checking.delete(rec.id));
    return { text, error };
  }
  if (!moreQueued) {
    resolveIdle(rec.id, { text, error });
    if (!rec.parentSessionId && rec.kind !== 'automation' && autoMode()) attentionNotify(rec, text, error, aborted, Date.now() - turn.startedAt, turn.tools.size);
    if (rec.parentSessionId) {
      const parent = getSession(rec.parentSessionId);
      notify(
        error && !aborted ? 'Coding agent failed' : aborted ? 'Coding agent stopped' : 'Coding agent finished',
        `${clip(rec.title, 60)}${parent ? ` · from "${clip(parent.title, 40)}"` : ''}${error && !aborted ? ` — ${clip(error, 100)}` : ''}`,
        error && !aborted ? 'error' : 'info',
        `#/workshop/${encodeURIComponent(rec.id)}`,
        { desktop: false },
      );
    }
  }
  return { text, error };
}

/* ─────────────── check before done (coding workers) ─────────────── */

const EDIT_TOOLS = /^(fs_write|fs_edit|Write|Edit|MultiEdit|NotebookEdit)$/;
const MAX_CHECK_ROUNDS = 2;
/** sessions whose post-turn check is running (count as busy for agent_wait) */
const checking = new Set<string>();

function resolveIdle(id: string, o: TurnOutcome): void {
  const ws = idleWaiters.get(id);
  if (!ws) return;
  idleWaiters.delete(id);
  for (const w of ws) w(o);
}

/**
 * After a worker turn that edited files: run the repo's check command. Pass → report "done" (with the check
 * result). Fail → feed the output back as a follow-up turn, up to MAX_CHECK_ROUNDS times, then report honestly.
 */
async function runCheck(rec: SessionRecord, text: string): Promise<void> {
  const cwd = effectiveCwd(rec);
  const prof = await getRepoProfile(cwd).catch(() => null);
  const finish = (note?: string) => {
    if (note) pushItem(rec, { kind: 'system', id: newId(), ts: nowIso(), text: note });
    const out = { text: note ? `${text}\n\n[${note}]` : text };
    resolveIdle(rec.id, out);
    if (!rec.parentSessionId && autoMode()) attentionNotify(rec, out.text, undefined, false, 0, 0);
    if (rec.parentSessionId) notify('Coding agent finished', `${clip(rec.title, 60)}${note ? ` — ${clip(note, 80)}` : ''}`, 'info', `#/workshop/${encodeURIComponent(rec.id)}`, { desktop: false });
  };
  if (!prof?.check) return finish();
  pushItem(rec, { kind: 'system', id: newId(), ts: nowIso(), text: `Running check: ${prof.check}` });
  const r = await runShell(prof.check, prof.path, 10 * 60_000);
  if (r.code === 0) return finish(`Check passed: ${prof.check}`);
  const rounds = rec.engineState.checkRounds ?? 0;
  const tail = r.output.length > 4000 ? `…${r.output.slice(-4000)}` : r.output;
  // exit 126/127 = command missing / not runnable: an environment problem, not something to loop on
  if (r.code === 126 || r.code === 127 || r.timedOut || rounds >= MAX_CHECK_ROUNDS) {
    const why = r.timedOut ? 'timed out after 10 min' : r.code >= 126 ? 'could not run (missing tool or setup?)' : `still failing after ${rounds} fix round${rounds === 1 ? '' : 's'}`;
    return finish(`Check FAILED (${why}): ${prof.check}\n${tail.slice(-1500)}`);
  }
  rec.engineState.checkRounds = rounds + 1;
  const msg = `[Monarch check] \`${prof.check}\` failed (exit ${r.code}) after your changes. Fix the cause, then finish. Output:\n\`\`\`\n${tail}\n\`\`\``;
  appendUser(rec, msg);
  void startTurn(rec, msg);
}

function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string; timedOut: boolean }> {
  return new Promise((res) => {
    const child = spawn('bash', ['-lc', cmd], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const add = (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      res({ code: 127, output: String(e), timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      res({ code: code ?? 1, output: out, timedOut });
    });
  });
}

/**
 * Auto mode: tell the user only when they are needed — a question/blocker or a failure (desktop notification),
 * or a long job finishing (in-app only). Short back-and-forth turns stay quiet.
 */
function attentionNotify(rec: SessionRecord, text: string, error: string | undefined, aborted: boolean, ms: number, tools: number): void {
  if (aborted) return;
  const href = rec.kind === 'coding' ? `#/workshop/${encodeURIComponent(rec.id)}` : `#/chat/${encodeURIComponent(rec.id)}`;
  const last = text.trim();
  if (error) return void notify('Agent failed', `${clip(rec.title, 60)} — ${clip(error, 140)}`, 'error', href);
  const asks = /\?\s*(?:\*\*)?\s*$/.test(last.split('\n').filter(Boolean).pop() ?? '');
  const long = ms >= 45_000 || tools >= 4;
  if (asks && long) return void notify('Needs your input', `${clip(rec.title, 50)}: ${clip(last.split('\n').filter(Boolean).pop() ?? '', 160)}`, 'warn', href);
  if (long) notify('Done', `${clip(rec.title, 50)} — ${clip(last.replace(/[#*`_>|-]+/g, ' ').replace(/\s+/g, ' '), 160)}`, 'success', href, { desktop: false });
}

/* ─────────────── commands ─────────────── */

function defaultModel(engine: EngineId): string {
  const s = getSettings();
  return engine === 'pi' ? s.pi.model : s.claudeSdk.model;
}

function newSession(opts: { kind?: SessionKind; engine?: EngineId; model?: string; cwd?: string; title?: string; parentSessionId?: string }): SessionRecord {
  const s = getSettings();
  const kind: SessionKind = opts.kind ?? 'chat';
  const engine: EngineId = opts.engine === 'pi' || opts.engine === 'claude-sdk' ? opts.engine : s.engine;
  let model = opts.model?.trim() || defaultModel(engine);
  let piProvider: string | undefined;
  if (engine === 'pi') {
    piProvider = s.pi.provider;
    try {
      const r = resolvePiModel(s.pi.provider, model);
      if (r.model) {
        piProvider = r.provider;
        model = r.model.id;
      }
    } catch {
      /* keep raw spec; the engine reports a clean error */
    }
  }
  const cwd = kind === 'coding' ? opts.cwd?.trim() || s.coding.defaultWorkspace : opts.cwd?.trim() || undefined;
  return createSession({ kind, engine, model, cwd, title: opts.title, piProvider, parentSessionId: opts.parentSessionId });
}

/**
 * Switch an existing session to another model of the SAME engine (history can't move between engines).
 * Takes effect from the next turn: pi swaps the agent's model, claude-sdk resumes with the new model.
 */
function switchModel(rec: SessionRecord, engine: EngineId | undefined, spec: string | undefined): void {
  const want = spec?.trim();
  if (!want) return;
  if (engine && engine !== rec.engine) {
    activity('AGT', `Model change ignored — session runs on ${rec.engine}, not ${engine}`, 'warn', rec.id);
    return;
  }
  let model = want;
  if (rec.engine === 'pi') {
    try {
      const r = resolvePiModel(rec.engineState.piProvider || getSettings().pi.provider, want);
      if (!r.model) {
        activity('AGT', `Unknown model "${want}" — keeping ${rec.model}`, 'warn', rec.id);
        return;
      }
      rec.engineState.piProvider = r.provider;
      model = r.model.id;
    } catch (e) {
      activity('AGT', `Model change failed: ${e instanceof Error ? e.message : String(e)}`, 'warn', rec.id);
      return;
    }
  }
  if (model === rec.model) return;
  rec.model = model;
  saveSession(rec);
  broadcastSession(rec);
  activity('AGT', `Model switched to ${model}`, 'info', rec.id);
}

function chatSend(cmd: Extract<ClientCommand, { type: 'chat.send' }>): void {
  const text = (cmd.text ?? '').trim();
  let rec: SessionRecord | undefined;
  if (cmd.sessionId) {
    rec = getSession(cmd.sessionId);
    if (!rec) {
      bus.broadcast({ type: 'chat.done', sessionId: cmd.sessionId, error: 'Session not found' });
      return;
    }
    switchModel(rec, cmd.engine, cmd.model);
  } else {
    rec = newSession({ kind: cmd.kind, engine: cmd.engine, model: cmd.model, cwd: cmd.cwd });
    broadcastSession(rec, cmd.clientRef);
  }
  if (!text) return;
  if (/^\/compact\s*$/i.test(text)) {
    const r = compactSession(rec.id);
    if (r !== 'started') pushItem(rec, { kind: 'system', id: newId(), ts: nowIso(), text: r === 'busy' ? 'Cannot compact while a turn is running.' : 'Nothing to compact.' });
    return;
  }
  if (active.has(rec.id)) {
    const q = queued.get(rec.id) ?? [];
    q.push(text);
    queued.set(rec.id, q);
    activity(rec.kind === 'coding' ? 'CODE' : 'AGT', `Queued follow-up · ${clip(text, 60)}`, 'info', rec.id);
    return;
  }
  rec.engineState.checkRounds = 0;
  appendUser(rec, text);
  void startTurn(rec, text);
}

/** compact a session's context now (manual /compact). Runs as a turn without a user item. */
export function compactSession(sessionId: string): 'started' | 'busy' | 'not-found' {
  const rec = getSession(sessionId);
  if (!rec) return 'not-found';
  if (active.has(rec.id)) return 'busy';
  void startTurn(rec, '/compact', 'compact');
  return 'started';
}

/** stop the running turn of a session (and drop its queued follow-ups) */
export function abortSession(sessionId: string): boolean {
  queued.delete(sessionId);
  rejectSessionApprovals(sessionId);
  const t = active.get(sessionId);
  if (!t) return false;
  t.abort.abort();
  return true;
}

/** abort + forget engine state + delete the session file */
export function removeSession(sessionId: string): boolean {
  abortSession(sessionId);
  for (const e of Object.values(engines)) e.dispose?.(sessionId);
  clearSessionAllowances(sessionId);
  return deleteSession(sessionId);
}

/** handle a WebSocket command from the UI (chat.send / chat.abort / approval.respond). ping is handled by server.ts */
export function handleClientCommand(cmd: ClientCommand): void {
  try {
    switch (cmd.type) {
      case 'chat.send':
        chatSend(cmd);
        break;
      case 'chat.abort':
        abortSession(cmd.sessionId);
        break;
      case 'approval.respond':
        respondApproval(cmd.id, !!cmd.allow, !!cmd.always);
        break;
      default:
        break;
    }
  } catch (e) {
    console.error('[agent] command failed', e);
    activity('ERR', `Agent command failed: ${clip(errorText(e), 120)}`, 'error');
  }
}

/** run a prompt to completion in a new session (used by automations / scheduler). Never throws; errors go to `error`. */
export async function runPrompt(opts: {
  text: string;
  kind: SessionKind;
  title?: string;
  engine?: EngineId;
  model?: string;
  cwd?: string;
}): Promise<{ sessionId: string; text: string; error?: string }> {
  let sessionId = '';
  try {
    const rec = newSession({ kind: opts.kind, engine: opts.engine, model: opts.model, cwd: opts.cwd, title: opts.title });
    sessionId = rec.id;
    broadcastSession(rec);
    const text = (opts.text ?? '').trim();
    if (!text) return { sessionId, text: '', error: 'empty prompt' };
    const keepTitle = rec.title;
    appendUser(rec, text);
    if (opts.title) {
      rec.title = keepTitle;
      saveSession(rec);
    }
    const out = await startTurn(rec, text);
    return { sessionId, text: out.text, error: out.error };
  } catch (e) {
    return { sessionId, text: '', error: errorText(e) };
  }
}

/**
 * Like runPrompt, but returns as soon as the session exists (the turn keeps running in the background).
 * `done` settles when the turn finishes; it never rejects. Used by self-evolution (forge / reflection).
 */
export function startPrompt(opts: {
  text: string;
  kind: SessionKind;
  title?: string;
  engine?: EngineId;
  model?: string;
  cwd?: string;
  /** the session whose agent started this one (delegation) */
  parentSessionId?: string;
}): { sessionId: string; done: Promise<{ text: string; error?: string }> } {
  const rec = newSession({ kind: opts.kind, engine: opts.engine, model: opts.model, cwd: opts.cwd, title: opts.title, parentSessionId: opts.parentSessionId });
  broadcastSession(rec);
  const text = (opts.text ?? '').trim();
  if (!text) return { sessionId: rec.id, done: Promise.resolve({ text: '', error: 'empty prompt' }) };
  const keepTitle = rec.title;
  appendUser(rec, text);
  if (opts.title) {
    rec.title = keepTitle;
    saveSession(rec);
    broadcastSession(rec);
  }
  const done = startTurn(rec, text).catch((e) => ({ text: '', error: errorText(e) }));
  return { sessionId: rec.id, done };
}

/** called once at startup */
export async function initAgent(): Promise<void> {
  listSessions(); // index session files
  process.once('beforeExit', flushSessions);
}

/** for tests / shutdown */
export function flushAgentState(): void {
  flushSessions();
}

export function isSessionRunning(sessionId: string): boolean {
  return active.has(sessionId) || checking.has(sessionId);
}

/* ─────────────── delegation helpers (tools/delegate.ts) ─────────────── */

/**
 * Send a follow-up to an existing session from code (same semantics as chat.send):
 * starts a turn when idle, queues it when a turn is running. Returns what happened.
 */
export function sendToSession(sessionId: string, text: string): 'started' | 'queued' | 'not-found' {
  const rec = getSession(sessionId);
  if (!rec) return 'not-found';
  const t = text.trim();
  if (!t) return active.has(rec.id) ? 'queued' : 'started';
  if (active.has(rec.id)) {
    const q = queued.get(rec.id) ?? [];
    q.push(t);
    queued.set(rec.id, q);
    activity(rec.kind === 'coding' ? 'CODE' : 'AGT', `Queued follow-up · ${clip(t, 60)}`, 'info', rec.id);
    return 'queued';
  }
  rec.engineState.checkRounds = 0;
  appendUser(rec, t);
  void startTurn(rec, t);
  return 'started';
}

/** switch an existing session's model (same engine only); returns the model now in use */
export function setSessionModel(sessionId: string, engine: EngineId | undefined, spec: string): string {
  const rec = getSession(sessionId);
  if (!rec) throw new Error(`Session not found: ${sessionId}`);
  switchModel(rec, engine, spec);
  return rec.model;
}

export function queuedCount(sessionId: string): number {
  return queued.get(sessionId)?.length ?? 0;
}

/** current phase of a running session ('idle' when not running) */
export function sessionPhase(sessionId: string): AgentPhase {
  return active.get(sessionId)?.phase ?? 'idle';
}

/**
 * Resolve when the session has no running turn and no queued follow-ups (last turn's final text),
 * or `null` on timeout / abort of the waiting signal. Resolves immediately when already idle.
 */
export function waitForSessionIdle(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<TurnOutcome | null> {
  if (!active.has(sessionId) && !checking.has(sessionId) && !queued.get(sessionId)?.length) return Promise.resolve({ text: '' });
  return new Promise((resolve) => {
    let set = idleWaiters.get(sessionId);
    if (!set) idleWaiters.set(sessionId, (set = new Set()));
    const done = (o: TurnOutcome | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      idleWaiters.get(sessionId)?.delete(w);
      resolve(o);
    };
    const w = (o: TurnOutcome) => done(o);
    const onAbort = () => done(null);
    const timer = setTimeout(() => done(null), Math.max(0, timeoutMs));
    signal?.addEventListener('abort', onAbort, { once: true });
    set.add(w);
  });
}
