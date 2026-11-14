/**
 * Agent orchestrator (Core-B). Contract exports: handleClientCommand, runPrompt, currentPhase, initAgent.
 *
 * Turns engine events (engines/types.ts) into ChatItems + ServerEvents, enforces one turn at a time
 * per session (extra messages queue as follow-ups), routes tool approvals, tracks usage and phases.
 */
import type { AgentPhase, ChatItem, ClientCommand, EngineId, SessionKind, Usage } from '@monarch/shared';
import { activity, bus, newId, nowIso, truncate } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { recordUsage } from '../services/usage.ts';
import { needsApproval, rejectSessionApprovals, requestApproval, respondApproval, clearSessionAllowances } from './approvals.ts';
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
  }
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

async function approve(turn: ActiveTurn, ask: ApprovalAsk): Promise<boolean> {
  if (!needsApproval(turn.rec.id, ask.name, ask.risk)) return true;
  const item = toolStart(turn, { type: 'tool-start', callId: ask.callId, name: ask.name, input: ask.input, risk: ask.risk });
  item.status = 'pending-approval';
  updateItem(turn.rec, item);
  setPhase(turn, 'awaiting-approval', ask.summary);
  const ok = await requestApproval(turn.rec.id, ask.name, ask.input, ask.risk, ask.summary, turn.abort.signal);
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

async function startTurn(rec: SessionRecord, text: string): Promise<TurnOutcome> {
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
  setPhase(turn, 'thinking');
  const tag = rec.kind === 'coding' ? 'CODE' : 'AGT';
  activity(tag, `${rec.kind === 'automation' ? 'Automation' : 'Turn'} started · ${clip(rec.title, 60)}`, 'info', rec.id);

  let result: TurnResult;
  try {
    const engine = engines[rec.engine] ?? engines['claude-sdk'];
    const cwd = effectiveCwd(rec);
    const systemPrompt = await buildSystemPrompt({ kind: rec.kind, cwd, engine: engine.id });
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
    result = await engine.runTurn(ctx);
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
  return { text, error };
}

/* ─────────────── commands ─────────────── */

function defaultModel(engine: EngineId): string {
  const s = getSettings();
  return engine === 'pi' ? s.pi.model : s.claudeSdk.model;
}

function newSession(opts: { kind?: SessionKind; engine?: EngineId; model?: string; cwd?: string; title?: string }): SessionRecord {
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
  return createSession({ kind, engine, model, cwd, title: opts.title, piProvider });
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
  if (active.has(rec.id)) {
    const q = queued.get(rec.id) ?? [];
    q.push(text);
    queued.set(rec.id, q);
    activity(rec.kind === 'coding' ? 'CODE' : 'AGT', `Queued follow-up · ${clip(text, 60)}`, 'info', rec.id);
    return;
  }
  appendUser(rec, text);
  void startTurn(rec, text);
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
}): { sessionId: string; done: Promise<{ text: string; error?: string }> } {
  const rec = newSession({ kind: opts.kind, engine: opts.engine, model: opts.model, cwd: opts.cwd, title: opts.title });
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
  return active.has(sessionId);
}
