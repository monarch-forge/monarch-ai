/**
 * Open-threads board: a per-chat-session working memory of ongoing work (Letta/MemGPT-style).
 * Stored in the session's engineState (persisted with the session, survives compaction because it is
 * never part of the transcript). A compact summary is pinned into the agent's context every turn:
 * claude-sdk via the system prompt, pi via a <context> note in the user turn (only when it changed).
 * Linked workers report back: when a worker linked to a thread finishes, the thread is marked
 * needsReport and, if the chat is idle, one short follow-up turn is started in the chat.
 */
import type { ChatThread, ThreadLink, ThreadStatus } from '@monarch/shared';
import { bus, newId, nowIso } from '../kernel.ts';
import type { SessionRecord } from './sessions.ts';

const MAX_THREADS = 40;
const MAX_LINES = 8;
const MAX_CHARS = 1000; // ~250 tokens

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const norm = (s: string) => s.trim().toLowerCase();

export function threadsOf(rec: SessionRecord): ChatThread[] {
  return (rec.engineState.threads ??= []);
}

export interface UpsertInput {
  id?: string;
  title?: string;
  area?: string;
  status?: ThreadStatus;
  next?: string;
  links?: ThreadLink[];
}

/** create or update a thread (match by id, else case-insensitive title); returns the thread */
export function upsertThread(list: ChatThread[], i: UpsertInput, now = nowIso()): ChatThread {
  let t = i.id ? list.find((x) => x.id === i.id) : undefined;
  if (!t && i.title) t = list.find((x) => norm(x.title) === norm(i.title!));
  if (!t) {
    // models often invent ids for new threads: with a title, just create it
    if (i.id && !i.title?.trim()) throw new Error(`No thread ${i.id}`);
    if (!i.title?.trim()) throw new Error('title is required for a new thread');
    t = { id: newId().slice(0, 8), title: clip(i.title.trim(), 80), area: i.area?.trim() || 'general', status: 'open', links: [], updatedAt: now };
    list.push(t);
  }
  if (i.title?.trim()) t.title = clip(i.title.trim(), 80);
  if (i.area?.trim()) t.area = i.area.trim().slice(0, 40);
  if (i.status) t.status = i.status;
  if (i.next !== undefined) t.next = i.next.trim() ? clip(i.next.trim(), 160) : undefined;
  for (const l of i.links ?? []) {
    if (!t.links.some((x) => x.kind === l.kind && x.ref === l.ref)) t.links.push({ kind: l.kind, ref: l.ref, ...(l.label ? { label: clip(l.label, 60) } : {}) });
  }
  t.needsReport = undefined; // the agent touched it: report handled
  t.pendingNudge = undefined;
  t.updatedAt = now;
  // keep the board bounded: drop the oldest done threads first
  while (list.length > MAX_THREADS) {
    const done = list.filter((x) => x.status === 'done').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    list.splice(list.indexOf(done ?? list[0]), 1);
  }
  return t;
}

/** compact board for the prompt: open/waiting only, newest first, ≤ MAX_LINES lines and MAX_CHARS chars */
export function boardSummary(list: ChatThread[]): string {
  const live = list.filter((t) => t.status !== 'done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!live.length) return '';
  const lines: string[] = [];
  let len = 0;
  for (const t of live) {
    const worker = t.links.find((l) => l.kind === 'worker');
    const line = clip(
      `- [${t.id}] (${t.area}) ${t.title} · ${t.status}${t.needsReport ? ' · NEEDS REPORT' : ''}${t.next ? ` · next: ${t.next}` : ''}${worker ? ` · worker ${worker.ref}` : ''}`,
      180,
    );
    if (lines.length >= MAX_LINES || len + line.length > MAX_CHARS) {
      lines.push(`… ${live.length - lines.length} more open`);
      break;
    }
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join('\n');
}

export const BOARD_RULE =
  'Open threads board: keep it current with thread_upsert when you start, hand off or finish something (status done when finished). Tag every thread with its area (work, personal, repo:<name>, person:<name>) and never mix areas in one thread or reply.';

/** the pinned block (empty when there is nothing open) */
export function boardBlock(rec: SessionRecord | undefined): string {
  if (!rec || rec.kind !== 'chat') return '';
  const s = boardSummary(threadsOf(rec));
  return s ? `Open threads (newest first; update with thread_upsert):\n${s}` : '';
}

/**
 * pi: prefix the pinned board to the user turn only when it changed since the last note (the system prompt
 * stays stable for caching). Compaction clears threadsNote so the board is re-sent.
 */
export function withThreadsNote(rec: SessionRecord, text: string): string {
  const block = boardBlock(rec);
  if (block === (rec.engineState.threadsNote ?? '')) return text;
  rec.engineState.threadsNote = block;
  return `<context>\n${block || 'Open threads: none (board is empty).'}\n</context>\n\n${text}`;
}

export function broadcastThreads(sessionId: string): void {
  bus.broadcast({ type: 'data.changed', collection: 'threads' });
  void sessionId;
}

/* ─────────────── worker follow-up ─────────────── */

const FOLLOW_PREFIX = '[Monarch] Worker';
const MAX_AUTO = 3;

/**
 * A worker (child session) finished a turn. Mark linked threads needsReport; if the parent chat is idle,
 * start one short follow-up turn there. Once per worker completion (keyed by the worker's item count),
 * never for aborted turns, never while the parent is busy (it is probably waiting on the worker itself).
 */
export function onWorkerFinished(
  worker: SessionRecord,
  text: string,
  error: string | undefined,
  aborted: boolean,
  deps: {
    getSession: (id: string) => SessionRecord | undefined;
    isRunning: (id: string) => boolean;
    send: (id: string, text: string) => unknown;
    save: (rec: SessionRecord) => void;
  },
): string | undefined {
  if (aborted || !worker.parentSessionId) return;
  const parent = deps.getSession(worker.parentSessionId);
  if (!parent || parent.kind !== 'chat') return;
  const hits = threadsOf(parent).filter((t) => t.status !== 'done' && t.links.some((l) => l.kind === 'worker' && l.ref === worker.id));
  if (!hits.length) return;
  const key = `${worker.id}:${worker.items.length}`;
  if (hits.every((t) => t.reportedKey === key)) return;
  for (const t of hits) {
    t.needsReport = true;
    t.reportedKey = key;
    t.updatedAt = nowIso();
  }
  const result = clip((error ? `failed: ${error}` : text || '(no reply)').replace(/\s+/g, ' ').trim(), 200);
  const msg = `${FOLLOW_PREFIX} for thread '${hits[0].title}' finished: ${result}. Update the thread and report.`;
  // parent busy (often waiting on this very worker): park the nudge; flushNudge sends it after that turn
  // unless the agent updated the thread meanwhile (which clears needsReport/pendingNudge)
  if (deps.isRunning(parent.id)) hits[0].pendingNudge = msg;
  deps.save(parent);
  broadcastThreads(parent.id);
  if (deps.isRunning(parent.id)) return;
  return nudge(parent, msg, deps.send);
}

function nudge(parent: SessionRecord, msg: string, send: (id: string, text: string) => unknown): string | undefined {
  // loop guard: at most MAX_AUTO auto follow-ups in a row without a real user message in between
  const users = parent.items.filter((x) => x.kind === 'user').slice(-MAX_AUTO);
  if (users.length === MAX_AUTO && users.every((u) => u.kind === 'user' && u.text.startsWith(FOLLOW_PREFIX))) return;
  send(parent.id, msg);
  return msg;
}

/** a chat turn ended with nothing queued: send a parked worker nudge the agent did not already handle */
export function flushNudge(rec: SessionRecord, send: (id: string, text: string) => unknown): string | undefined {
  if (rec.kind !== 'chat') return;
  const msg = threadsOf(rec).find((x) => x.pendingNudge && x.needsReport)?.pendingNudge;
  for (const x of threadsOf(rec)) x.pendingNudge = undefined;
  return msg ? nudge(rec, msg, send) : undefined;
}
