/**
 * Command-console chat tracking (module-level so a streaming reply survives navigation).
 * The console keeps ONE rolling conversation: follow-ups go to the same session until it has been idle
 * for 30 minutes, or the user starts fresh with the New button or `/new`. `sendNewChat` creates a session
 * and resolves its id from the first matching `session.updated`; `consoleRun` mirrors the latest reply.
 */
import { signal } from '@preact/signals';
import type { ServerEvent } from '@monarch/shared';
import { socket } from '../../lib/api.ts';
import { settings } from '../../lib/store.ts';
import { speak } from '../../lib/voice.ts';

export interface ConsoleRun {
  ref: string;
  prompt: string;
  sentAt: number;
  sessionId?: string;
  status: 'sending' | 'thinking' | 'tool' | 'streaming' | 'done' | 'error';
  /** latest assistant text */
  reply: string;
  /** id of the assistant item currently mirrored */
  itemId?: string;
  tool?: string;
  error?: string;
  /** turn number inside the rolling conversation (1 = first) */
  turn?: number;
}

/** the console's rolling conversation (persisted so it survives reloads) */
export interface ConsoleConversation {
  id: string;
  lastAt: number;
  turns: number;
}
const CONV_KEY = 'monarch.console.conversation';
/** start a fresh conversation after this much inactivity */
export const CONSOLE_IDLE_MS = 30 * 60_000;

function loadConversation(): ConsoleConversation | null {
  try {
    const v = JSON.parse(localStorage.getItem(CONV_KEY) ?? 'null') as ConsoleConversation | null;
    if (v?.id && Date.now() - v.lastAt < CONSOLE_IDLE_MS) return v;
  } catch {
    /* storage unavailable */
  }
  return null;
}
export const consoleConversation = signal<ConsoleConversation | null>(loadConversation());
function setConversation(v: ConsoleConversation | null): void {
  consoleConversation.value = v;
  try {
    if (v) localStorage.setItem(CONV_KEY, JSON.stringify(v));
    else localStorage.removeItem(CONV_KEY);
  } catch {
    /* storage unavailable */
  }
}
/** the conversation follow-ups should go to, or null when it's expired / absent */
export function activeConversation(): ConsoleConversation | null {
  const c = consoleConversation.value;
  return c && Date.now() - c.lastAt < CONSOLE_IDLE_MS ? c : null;
}
/** forget the rolling conversation; the next command starts a new session */
export function newConsoleConversation(): void {
  setConversation(null);
  consoleRun.value = null;
}

export const consoleRun = signal<ConsoleRun | null>(null);
/** commands sent from the console this session (newest last) for ↑ recall */
export const consoleHistory = signal<string[]>([]);

interface Waiter {
  ref: string;
  sentAt: number;
  resolve: (id: string) => void;
  reject: (e: Error) => void;
  timer: number;
}
const waiters: Waiter[] = [];
const claimed = new Set<string>();

function newRef(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** send `chat.send` creating a new session; resolves with the new session id */
export function sendNewChat(text: string): { ref: string; session: Promise<string> } {
  const ref = newRef();
  const sentAt = Date.now();
  const session = new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const i = waiters.findIndex((w) => w.ref === ref);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('No session from core'));
    }, 45000);
    waiters.push({ ref, sentAt, resolve, reject, timer });
  });
  socket.send({ type: 'chat.send', text, clientRef: ref, kind: 'chat' });
  return { ref, session };
}

function resolveWaiter(ev: Extract<ServerEvent, { type: 'session.updated' }>) {
  if (!waiters.length || claimed.has(ev.session.id)) return;
  const echoed: string | undefined = (ev as any).clientRef ?? (ev.session as any).clientRef;
  let idx = -1;
  if (echoed) idx = waiters.findIndex((w) => w.ref === echoed);
  else {
    // no correlation id on the wire: take the oldest waiter whose send predates this session's creation
    const created = Date.parse(ev.session.createdAt);
    idx = waiters.findIndex((w) => isNaN(created) || created >= w.sentAt - 10_000);
  }
  if (idx < 0) return;
  const [w] = waiters.splice(idx, 1);
  window.clearTimeout(w.timer);
  claimed.add(ev.session.id);
  w.resolve(ev.session.id);
}

/**
 * run a console command: continues the rolling conversation (or starts one), tracks the reply,
 * speaks it when done (if enabled). `/new` starts a fresh conversation; `/new <text>` also sends text.
 */
export function runConsoleCommand(text: string): void {
  let prompt = text.trim();
  if (!prompt) return;
  const fresh = /^\/new\b/i.test(prompt);
  if (fresh) {
    newConsoleConversation();
    prompt = prompt.replace(/^\/new\b/i, '').trim();
    if (!prompt) return;
  }
  consoleHistory.value = [...consoleHistory.value.filter((h) => h !== prompt), prompt].slice(-30);

  const conv = activeConversation();
  if (conv) {
    const ref = newRef();
    const turn = conv.turns + 1;
    socket.send({ type: 'chat.send', sessionId: conv.id, text: prompt, clientRef: ref });
    consoleRun.value = { ref, prompt, sentAt: Date.now(), sessionId: conv.id, status: 'thinking', reply: '', turn };
    setConversation({ id: conv.id, lastAt: Date.now(), turns: turn });
    return;
  }

  const { ref, session } = sendNewChat(prompt);
  consoleRun.value = { ref, prompt, sentAt: Date.now(), status: 'sending', reply: '', turn: 1 };
  session.then(
    (id) => {
      setConversation({ id, lastAt: Date.now(), turns: 1 });
      const r = consoleRun.value;
      if (r?.ref === ref) consoleRun.value = { ...r, sessionId: id, status: r.status === 'sending' ? 'thinking' : r.status };
    },
    (e: Error) => {
      const r = consoleRun.value;
      if (r?.ref === ref && !r.sessionId) consoleRun.value = { ...r, status: 'error', error: e.message };
    },
  );
}

export function dismissConsoleRun(): void {
  consoleRun.value = null;
}

function patch(p: Partial<ConsoleRun>) {
  const r = consoleRun.value;
  if (r) consoleRun.value = { ...r, ...p };
}

socket.on((ev) => {
  if (ev.type === 'session.updated') {
    resolveWaiter(ev);
    return;
  }
  if (ev.type === 'session.deleted' && consoleConversation.value?.id === ev.sessionId) {
    newConsoleConversation();
    return;
  }
  const r = consoleRun.value;
  if (!r?.sessionId) return;
  if (!('sessionId' in ev) || ev.sessionId !== r.sessionId) return;

  switch (ev.type) {
    case 'chat.item': {
      const it = ev.item;
      if (it.kind === 'assistant') patch({ itemId: it.id, reply: it.text ?? '', status: it.text ? 'streaming' : 'thinking', tool: undefined });
      else if (it.kind === 'tool') patch({ tool: it.name, status: 'tool' });
      else if (it.kind === 'error') patch({ error: it.message });
      break;
    }
    case 'chat.delta': {
      if (!ev.text) break;
      if (r.itemId === ev.itemId) patch({ reply: r.reply + ev.text, status: 'streaming', tool: undefined });
      else patch({ itemId: ev.itemId, reply: ev.text, status: 'streaming', tool: undefined });
      break;
    }
    case 'chat.item.update': {
      const it = ev.item;
      if (it.kind === 'assistant' && (it.id === r.itemId || !r.itemId)) patch({ itemId: it.id, reply: it.text ?? r.reply });
      else if (it.kind === 'tool' && it.name === r.tool && it.status !== 'running' && it.status !== 'pending-approval') patch({ status: 'thinking' });
      else if (it.kind === 'tool' && it.status === 'pending-approval') patch({ tool: it.name, status: 'tool' });
      break;
    }
    case 'chat.done': {
      const err = ev.error ?? (r.reply ? undefined : r.error);
      patch({ status: err && !r.reply ? 'error' : 'done', error: err, tool: undefined });
      const conv = consoleConversation.value;
      if (conv?.id === r.sessionId) {
        // the session vanished (deleted elsewhere): next command starts fresh
        if (ev.error === 'Session not found') setConversation(null);
        else setConversation({ ...conv, lastAt: Date.now() });
      }
      if (r.reply && settings.value?.assistant.voice.speak) void speak(r.reply);
      break;
    }
    case 'agent.phase': {
      if (ev.phase === 'tool' && ev.detail) patch({ tool: ev.detail, status: 'tool' });
      break;
    }
  }
});
