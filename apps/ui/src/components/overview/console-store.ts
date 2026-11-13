/**
 * Command-console chat tracking (module-level so a streaming reply survives navigation).
 * `sendNewChat` starts a new chat session over the socket and resolves its session id from the
 * first matching `session.updated`; `consoleRun` mirrors the assistant's reply for the overview preview.
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

/** run a console command: sends, tracks the reply, speaks it when done (if enabled) */
export function runConsoleCommand(text: string): void {
  const prompt = text.trim();
  if (!prompt) return;
  consoleHistory.value = [...consoleHistory.value.filter((h) => h !== prompt), prompt].slice(-30);
  const { ref, session } = sendNewChat(prompt);
  consoleRun.value = { ref, prompt, sentAt: Date.now(), status: 'sending', reply: '' };
  session.then(
    (id) => {
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
      if (r.reply && settings.value?.assistant.voice.speak) void speak(r.reply);
      break;
    }
    case 'agent.phase': {
      if (ev.phase === 'tool' && ev.detail) patch({ tool: ev.detail, status: 'tool' });
      break;
    }
  }
});
