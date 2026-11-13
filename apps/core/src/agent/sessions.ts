/**
 * Chat session persistence.
 *
 * Format: one JSON file per session at `paths.sessions/<id>.json` containing the full
 * `SessionDetail` (wire shape, `running` always persisted as false) plus an `engine` block with
 * engine-private state that never leaves the core:
 *   - claude-sdk: `sdkSessionId` (Claude Code session to `resume`) and `sdkCwd` (cwd it was created in;
 *                 Claude Code stores transcripts per cwd, so resume must use the same one)
 *   - pi:         `piProvider` and `piMessages` (pi-agent-core's own transcript minus system messages,
 *                 so tool calls/results and thinking survive restarts exactly)
 * Summaries for every file are indexed once at first use; full records are cached in memory
 * after first access and written back with a short debounce.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatItem, EngineId, SessionDetail, SessionKind, SessionSummary, Usage } from '@monarch/shared';
import { paths, newId, nowIso, bus } from '../kernel.ts';

export interface EngineState {
  sdkSessionId?: string;
  sdkCwd?: string;
  piProvider?: string;
  piMessages?: unknown[];
}

export interface SessionRecord extends SessionDetail {
  engine: EngineId;
  engineState: EngineState;
}

const records = new Map<string, SessionRecord>();
const summaries = new Map<string, SessionSummary>();
let indexed = false;
const timers = new Map<string, NodeJS.Timeout>();

const fileOf = (id: string) => join(paths.sessions, `${id}.json`);
const validId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens || 0),
    outputTokens: a.outputTokens + (b.outputTokens || 0),
    cacheReadTokens: (a.cacheReadTokens || 0) + (b.cacheReadTokens || 0),
    cacheWriteTokens: (a.cacheWriteTokens || 0) + (b.cacheWriteTokens || 0),
    costUsd: round6((a.costUsd || 0) + (b.costUsd || 0)),
  };
}
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function toSummary(r: SessionRecord): SessionSummary {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    engine: r.engine,
    model: r.model,
    cwd: r.cwd,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    itemCount: r.items.length,
    usage: r.usage,
    running: r.running,
  };
}

/** wire-safe detail (drops engine-private state) */
export function toDetail(r: SessionRecord): SessionDetail {
  return { ...toSummary(r), items: r.items };
}

function ensureIndex(): void {
  if (indexed) return;
  indexed = true;
  let files: string[] = [];
  try {
    files = readdirSync(paths.sessions).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const f of files) {
    const id = f.slice(0, -5);
    const r = readRecord(id);
    if (r) summaries.set(id, toSummary(r));
  }
}

function readRecord(id: string): SessionRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(fileOf(id), 'utf8')) as Partial<SessionRecord>;
    if (!raw || typeof raw !== 'object' || !raw.id) return undefined;
    return {
      id: raw.id,
      title: raw.title ?? 'Untitled',
      kind: raw.kind ?? 'chat',
      engine: raw.engine ?? 'claude-sdk',
      model: raw.model ?? '',
      cwd: raw.cwd,
      createdAt: raw.createdAt ?? nowIso(),
      updatedAt: raw.updatedAt ?? raw.createdAt ?? nowIso(),
      itemCount: raw.items?.length ?? 0,
      usage: { ...emptyUsage(), ...(raw.usage ?? {}) },
      running: false,
      items: (raw.items ?? []).map((it) =>
        // a crash mid-turn can leave streaming / running markers behind
        it.kind === 'assistant' && it.streaming
          ? { ...it, streaming: false }
          : it.kind === 'tool' && (it.status === 'running' || it.status === 'pending-approval')
            ? { ...it, status: 'error' as const, output: it.output ?? 'interrupted' }
            : it,
      ),
      engineState: raw.engineState ?? {},
    };
  } catch {
    return undefined;
  }
}

export function createSession(opts: {
  kind: SessionKind;
  engine: EngineId;
  model: string;
  cwd?: string;
  title?: string;
  piProvider?: string;
}): SessionRecord {
  ensureIndex();
  const ts = nowIso();
  const r: SessionRecord = {
    id: newId(),
    title: opts.title?.trim() || 'New session',
    kind: opts.kind,
    engine: opts.engine,
    model: opts.model,
    cwd: opts.cwd,
    createdAt: ts,
    updatedAt: ts,
    itemCount: 0,
    usage: emptyUsage(),
    running: false,
    items: [],
    engineState: opts.piProvider ? { piProvider: opts.piProvider } : {},
  };
  records.set(r.id, r);
  summaries.set(r.id, toSummary(r));
  saveSession(r, true);
  return r;
}

export function getSession(id: string): SessionRecord | undefined {
  if (!validId(id)) return undefined;
  const cached = records.get(id);
  if (cached) return cached;
  if (!existsSync(fileOf(id))) return undefined;
  const r = readRecord(id);
  if (r) records.set(id, r);
  return r;
}

export function listSessions(kind?: SessionKind): SessionSummary[] {
  ensureIndex();
  const out: SessionSummary[] = [];
  for (const [id, s] of summaries) {
    const live = records.get(id);
    const sum = live ? toSummary(live) : s;
    if (!kind || sum.kind === kind) out.push(sum);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** persist (debounced 150ms unless `now`) and refresh the summary index */
export function saveSession(r: SessionRecord, now = false): void {
  r.itemCount = r.items.length;
  summaries.set(r.id, toSummary(r));
  const write = () => {
    timers.delete(r.id);
    if (!records.has(r.id)) return; // deleted meanwhile
    const tmp = `${fileOf(r.id)}.tmp`;
    const { running: _running, ...rest } = r;
    writeFileSync(tmp, JSON.stringify({ ...rest, running: false }));
    renameSync(tmp, fileOf(r.id));
  };
  const t = timers.get(r.id);
  if (t) clearTimeout(t);
  if (now) write();
  else timers.set(r.id, setTimeout(write, 150));
}

export function flushSessions(): void {
  for (const [id, t] of timers) {
    clearTimeout(t);
    timers.delete(id);
    const r = records.get(id);
    if (r) saveSession(r, true);
  }
}

export function touch(r: SessionRecord): void {
  r.updatedAt = nowIso();
}

export function broadcastSession(r: SessionRecord, clientRef?: string): void {
  bus.broadcast(clientRef ? { type: 'session.updated', session: toSummary(r), clientRef } : { type: 'session.updated', session: toSummary(r) });
}

export function renameSession(id: string, title: string): SessionRecord | undefined {
  const r = getSession(id);
  if (!r) return undefined;
  r.title = title.trim().slice(0, 120) || r.title;
  touch(r);
  saveSession(r, true);
  broadcastSession(r);
  return r;
}

export function deleteSession(id: string): boolean {
  const r = getSession(id);
  if (!r) return false;
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  records.delete(id);
  summaries.delete(id);
  try {
    unlinkSync(fileOf(id));
  } catch {
    /* already gone */
  }
  bus.broadcast({ type: 'session.deleted', sessionId: id });
  return true;
}

export function findItem(r: SessionRecord, itemId: string): ChatItem | undefined {
  for (let i = r.items.length - 1; i >= 0; i--) if (r.items[i].id === itemId) return r.items[i];
  return undefined;
}

/** cheap auto-title from the first user message */
export function autoTitle(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return 'New session';
  if (one.length <= 48) return one;
  const cut = one.slice(0, 48);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 24 ? cut.slice(0, sp) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}
