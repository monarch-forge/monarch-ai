/**
 * Chat session state (UI-B): REST snapshot + live WebSocket events, with race-safe new-session creation.
 *
 *   const chat = useChatSession(id);            // id = null → "new session" mode
 *   const newId = await chat.sendMessage('hi', { kind: 'coding', cwd });
 *
 *   const { sessions } = useSessions('chat');   // live-merged session list
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatItem, ClientCommand, EngineId, ServerEvent, SessionDetail, SessionKind, SessionSummary, Usage } from '@monarch/shared';
import { api, qs, socket } from './api.ts';
import { useResource, useServerEvent } from './store.ts';

/* ───────────── module-level bookkeeping ───────────── */

/** every session id we have ever seen — a newly created session must not be one of these */
const seenSessionIds = new Set<string>();
/** recent chat.* events for sessions nobody is displaying yet (covers the create → navigate gap) */
const orphanEvents: ServerEvent[] = [];
const ORPHAN_MAX = 2000;

type SessionEvent = Extract<ServerEvent, { type: 'chat.item' | 'chat.delta' | 'chat.item.update' | 'chat.done' }>;

function isSessionEvent(ev: ServerEvent): ev is SessionEvent {
  return ev.type === 'chat.item' || ev.type === 'chat.delta' || ev.type === 'chat.item.update' || ev.type === 'chat.done';
}

socket.on((ev) => {
  if (ev.type === 'session.updated') seenSessionIds.add(ev.session.id);
  if (isSessionEvent(ev)) {
    orphanEvents.push(ev);
    if (orphanEvents.length > ORPHAN_MAX) orphanEvents.splice(0, orphanEvents.length - ORPHAN_MAX);
  }
});

/** forget buffered events for a session (it is now tracked by a hook) */
function takeOrphans(sessionId: string, sinceIndex = 0): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let i = sinceIndex; i < orphanEvents.length; i++) {
    const ev = orphanEvents[i] as SessionEvent;
    if (ev.sessionId === sessionId) out.push(ev);
  }
  return out;
}

/* ───────────── pure reducer ───────────── */

const LOCAL_PREFIX = 'local-';

export function applyChatEvent(d: SessionDetail, ev: SessionEvent): SessionDetail {
  switch (ev.type) {
    case 'chat.item': {
      if (d.items.some((it) => it.id === ev.item.id)) return applyChatEvent(d, { ...ev, type: 'chat.item.update' });
      let items = d.items;
      if (ev.item.kind === 'user') {
        // replace the optimistic copy of this message
        const text = ev.item.text.trim();
        const idx = items.findIndex((it) => it.kind === 'user' && it.id.startsWith(LOCAL_PREFIX) && it.text.trim() === text);
        const any = idx >= 0 ? idx : items.findIndex((it) => it.kind === 'user' && it.id.startsWith(LOCAL_PREFIX));
        if (any >= 0) items = items.filter((_, i) => i !== any);
      }
      return { ...d, items: [...items, ev.item], itemCount: Math.max(d.itemCount, items.length + 1) };
    }
    case 'chat.delta': {
      const idx = d.items.findIndex((it) => it.id === ev.itemId);
      if (idx < 0) {
        // delta for an item we never saw (joined mid-stream): synthesize an assistant item
        const item: ChatItem = { kind: 'assistant', id: ev.itemId, ts: new Date().toISOString(), text: ev.text ?? '', thinking: ev.thinking, streaming: true };
        return { ...d, items: [...d.items, item], running: true };
      }
      const it = d.items[idx];
      if (it.kind !== 'assistant') return d;
      const next: ChatItem = {
        ...it,
        text: ev.text ? it.text + ev.text : it.text,
        thinking: ev.thinking ? (it.thinking ?? '') + ev.thinking : it.thinking,
        streaming: true,
      };
      const items = d.items.slice();
      items[idx] = next;
      return { ...d, items, running: true };
    }
    case 'chat.item.update': {
      const idx = d.items.findIndex((it) => it.id === ev.item.id);
      if (idx < 0) return { ...d, items: [...d.items, ev.item] };
      const items = d.items.slice();
      items[idx] = ev.item;
      return { ...d, items };
    }
    case 'chat.done': {
      let items = d.items.map((it) => (it.kind === 'assistant' && it.streaming ? { ...it, streaming: false } : it));
      if (ev.error && !items.some((it) => it.kind === 'error' && it.message === ev.error)) {
        items = [...items, { kind: 'error', id: `${LOCAL_PREFIX}err-${Date.now()}`, ts: new Date().toISOString(), message: ev.error }];
      }
      return { ...d, items, running: false };
    }
  }
}

/* ───────────── useChatSession ───────────── */

export interface SendOptions {
  kind?: SessionKind;
  engine?: EngineId;
  model?: string;
  cwd?: string;
}

export interface TurnInfo {
  usage?: Usage;
  durationMs?: number;
  error?: string;
}

export interface ChatSession {
  /** the loaded (or freshly created) session; null in "new session" mode before the first send */
  session: SessionDetail | null;
  /** id actually being tracked (may differ from the hook argument right after creating a session) */
  sessionId: string | null;
  loading: boolean;
  error: string | undefined;
  running: boolean;
  /** usage/duration of the last finished turn */
  lastTurn: TurnInfo | null;
  /** send a message; resolves with the session id (new id when a session was created) */
  sendMessage: (text: string, opts?: SendOptions) => Promise<string>;
  abort: () => void;
  reload: () => Promise<void>;
}

interface PendingCreate {
  clientRef: string;
  sentAt: number;
  orphanIndex: number;
  kind: SessionKind;
  knownBefore: Set<string>;
  resolve: (id: string) => void;
  reject: (e: Error) => void;
  timer: number;
}

const CREATE_TIMEOUT_MS = 45_000;
/** tolerance for clock differences between UI and core when matching a new session by createdAt */
const CLOCK_SKEW_MS = 5_000;

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

function placeholderSession(text: string, opts: SendOptions): SessionDetail {
  const now = new Date().toISOString();
  return {
    id: '',
    title: text.split('\n')[0].slice(0, 80) || 'New session',
    kind: opts.kind ?? 'chat',
    engine: opts.engine ?? 'claude-sdk',
    model: opts.model ?? '',
    cwd: opts.cwd,
    createdAt: now,
    updatedAt: now,
    itemCount: 0,
    usage: emptyUsage(),
    running: true,
    items: [],
  };
}

export function useChatSession(sessionId: string | null): ChatSession {
  const [session, setSessionState] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [lastTurn, setLastTurn] = useState<TurnInfo | null>(null);

  const sessionRef = useRef<SessionDetail | null>(null);
  /** id whose events we apply */
  const trackedId = useRef<string | null>(null);
  /** events received while the REST snapshot is in flight */
  const buffer = useRef<SessionEvent[] | null>(null);
  const pending = useRef<PendingCreate | null>(null);
  const loadSeq = useRef(0);
  /** latest hook argument, read synchronously (independent of effect timing) */
  const propId = useRef<string | null>(sessionId);
  propId.current = sessionId;
  /** session created by this hook while the argument was null */
  const adoptedId = useRef<string | null>(null);
  if (sessionId) adoptedId.current = null;

  const setSession = useCallback((d: SessionDetail | null) => {
    sessionRef.current = d;
    setSessionState(d);
  }, []);

  const load = useCallback(
    async (id: string) => {
      const seq = ++loadSeq.current;
      trackedId.current = id;
      buffer.current = [];
      setLoading(true);
      setError(undefined);
      try {
        const d = await api.get<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
        if (seq !== loadSeq.current) return;
        seenSessionIds.add(d.id);
        let cur: SessionDetail = { ...d, items: d.items ?? [], usage: d.usage ?? emptyUsage() };
        // Replay buffered events. Deltas are skipped: the snapshot may already contain them, and the final
        // chat.item.update at end of streaming carries the authoritative text anyway.
        for (const ev of buffer.current ?? []) if (ev.type !== 'chat.delta') cur = applyChatEvent(cur, ev);
        buffer.current = null;
        setSession(cur);
      } catch (e: any) {
        if (seq !== loadSeq.current) return;
        buffer.current = null;
        setError(e?.status === 404 ? 'Session not found' : (e?.message ?? String(e)));
        setSession(null);
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [setSession],
  );

  // follow the hook argument
  useEffect(() => {
    if (sessionId && sessionRef.current?.id === sessionId) {
      trackedId.current = sessionId; // already have it (e.g. we just created it)
      return;
    }
    // switching away cancels a pending create's UI binding (the promise still resolves)
    loadSeq.current++;
    setLastTurn(null);
    if (!sessionId) {
      if (!pending.current) {
        adoptedId.current = null;
        trackedId.current = null;
        buffer.current = null;
        setSession(null);
        setLoading(false);
        setError(undefined);
      }
      return;
    }
    if (pending.current) {
      // navigated to another session while one was being created: detach (the promise rejects)
      const p = pending.current;
      pending.current = null;
      window.clearTimeout(p.timer);
      p.reject(new Error('Cancelled'));
    }
    setSession(null);
    void load(sessionId);
  }, [sessionId]);

  useEffect(
    () => () => {
      if (pending.current) window.clearTimeout(pending.current.timer);
    },
    [],
  );

  const adopt = useCallback(
    (summary: SessionSummary) => {
      const p = pending.current;
      if (!p) return;
      pending.current = null;
      window.clearTimeout(p.timer);
      seenSessionIds.add(summary.id);
      trackedId.current = summary.id;
      if (!propId.current) adoptedId.current = summary.id;
      const base = sessionRef.current;
      let cur: SessionDetail = { ...summary, items: base && !base.id ? base.items : [], running: true };
      for (const ev of takeOrphans(summary.id, p.orphanIndex)) cur = applyChatEvent(cur, ev);
      setSession(cur);
      p.resolve(summary.id);
    },
    [setSession],
  );

  useServerEvent(
    (ev) => {
      if (ev.type === 'session.updated') {
        const s = ev.session;
        const p = pending.current;
        if (p) {
          const ref = (ev as { clientRef?: string }).clientRef ?? (s as { clientRef?: string }).clientRef;
          const matchByRef = ref !== undefined && ref === p.clientRef;
          const matchByHeuristic =
            ref === undefined &&
            !p.knownBefore.has(s.id) &&
            s.kind === p.kind &&
            new Date(s.createdAt).getTime() >= p.sentAt - CLOCK_SKEW_MS;
          if (matchByRef || matchByHeuristic) {
            adopt(s);
            return;
          }
        }
        const cur = sessionRef.current;
        if (cur && cur.id === s.id) setSession({ ...cur, ...s, items: cur.items });
        return;
      }
      if (ev.type === 'session.deleted') {
        if (sessionRef.current?.id === ev.sessionId) {
          setSession(null);
          setError('Session deleted');
        }
        return;
      }
      if (!isSessionEvent(ev)) return;
      if (!trackedId.current || ev.sessionId !== trackedId.current) return;
      if (buffer.current) {
        buffer.current.push(ev);
        return;
      }
      const cur = sessionRef.current;
      if (!cur) return;
      if (ev.type === 'chat.done') setLastTurn({ usage: ev.usage, durationMs: ev.durationMs, error: ev.error });
      setSession(applyChatEvent(cur, ev));
    },
    [adopt],
  );

  const sendMessage = useCallback(
    (text: string, opts: SendOptions = {}): Promise<string> => {
      const body = text.trim();
      if (!body) return Promise.reject(new Error('Empty message'));
      const localUser: ChatItem = { kind: 'user', id: `${LOCAL_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), text: body };
      const cur = sessionRef.current;
      // target = the session the caller is showing; null argument → new session (or the one we just created)
      const id = propId.current ?? adoptedId.current;
      setLastTurn(null);

      if (id) {
        socket.send({ type: 'chat.send', sessionId: id, text: body });
        if (cur && cur.id === id) setSession({ ...cur, items: [...cur.items, localUser], running: true });
        return Promise.resolve(id);
      }

      if (pending.current) return Promise.reject(new Error('A session is already being created'));

      const clientRef = `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const placeholder = placeholderSession(body, opts);
      placeholder.items = [localUser];
      setSession(placeholder);
      setError(undefined);
      trackedId.current = null;

      return new Promise<string>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          if (pending.current?.clientRef !== clientRef) return;
          pending.current = null;
          const s = sessionRef.current;
          if (s && !s.id) setSession({ ...s, running: false, items: [...s.items, { kind: 'error', id: `${LOCAL_PREFIX}timeout`, ts: new Date().toISOString(), message: 'No response from core — the session was not created.' }] });
          reject(new Error('Timed out waiting for the new session'));
        }, CREATE_TIMEOUT_MS);
        pending.current = {
          clientRef,
          sentAt: Date.now(),
          orphanIndex: orphanEvents.length,
          kind: opts.kind ?? 'chat',
          knownBefore: new Set(seenSessionIds),
          resolve,
          reject,
          timer,
        };
        const cmd: ClientCommand = { type: 'chat.send', text: body, clientRef, kind: opts.kind ?? 'chat' };
        if (opts.engine) cmd.engine = opts.engine;
        if (opts.model) cmd.model = opts.model;
        if (opts.cwd) cmd.cwd = opts.cwd;
        socket.send(cmd);
      });
    },
    [setSession],
  );

  const abort = useCallback(() => {
    const id = sessionRef.current?.id || trackedId.current;
    if (id) socket.send({ type: 'chat.abort', sessionId: id });
  }, []);

  const reload = useCallback(async () => {
    const id = sessionRef.current?.id || trackedId.current;
    if (id) await load(id);
  }, [load]);

  return {
    session,
    sessionId: session?.id || trackedId.current || null,
    loading,
    error,
    running: !!session?.running,
    lastTurn,
    sendMessage,
    abort,
    reload,
  };
}

/* ───────────── useSessions ───────────── */

function byUpdatedDesc(a: SessionSummary, b: SessionSummary): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function useSessions(kind?: SessionKind) {
  const res = useResource<SessionSummary[]>(`/sessions${qs({ kind })}`, ['sessions']);
  const dataRef = useRef(res.data);
  dataRef.current = res.data;

  useEffect(() => {
    res.data?.forEach((s) => seenSessionIds.add(s.id));
  }, [res.data]);

  useServerEvent(
    (ev) => {
      if (ev.type === 'session.updated') {
        const s = ev.session;
        if (kind && s.kind !== kind) return;
        const list = dataRef.current ?? [];
        const next = list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [s, ...list];
        res.setData(next.sort(byUpdatedDesc));
      } else if (ev.type === 'session.deleted') {
        const list = dataRef.current;
        if (list?.some((x) => x.id === ev.sessionId)) res.setData(list.filter((x) => x.id !== ev.sessionId));
      }
    },
    [kind],
  );

  const sessions = useMemo(() => (res.data ? res.data.slice().sort(byUpdatedDesc) : undefined), [res.data]);
  return { sessions, loading: res.loading, error: res.error, reload: res.reload, setData: res.setData };
}

/* ───────────── small session actions ───────────── */

export async function renameSession(id: string, title: string): Promise<SessionSummary> {
  return api.patch<SessionSummary>(`/sessions/${encodeURIComponent(id)}`, { title });
}

export async function deleteSession(id: string): Promise<void> {
  await api.del(`/sessions/${encodeURIComponent(id)}`);
}

/** total tokens of a usage record */
export function totalTokens(u: Usage | undefined): number {
  if (!u) return 0;
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}
