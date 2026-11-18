/**
 * Global reactive state (Preact signals) fed by the core WebSocket.
 * OWNED BY THE ORCHESTRATOR — builders may add signals/hooks but must not change existing ones.
 */
import { signal, computed } from '@preact/signals';
import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import type {
  ActivityEntry,
  AgentPhase,
  ApprovalRequest,
  HealthInfo,
  Notification,
  OAuthFlowState,
  ServerEvent,
  Settings,
  SystemMetrics,
} from '@monarch/shared';
import { api, socket } from './api.ts';

export type ConnStatus = 'connecting' | 'open' | 'closed';

export const conn = signal<ConnStatus>('connecting');
export const health = signal<HealthInfo | null>(null);
export const phase = signal<AgentPhase>('idle');
export const phaseDetail = signal<string | undefined>(undefined);
export const phaseSession = signal<string | undefined>(undefined);
export const metrics = signal<SystemMetrics | null>(null);
/** rolling history for sparklines (last ~120 samples) */
export const metricsHistory = signal<SystemMetrics[]>([]);
export const activityLog = signal<ActivityEntry[]>([]);
export const notifications = signal<Notification[]>([]);
export const approvals = signal<ApprovalRequest[]>([]);
export const oauthFlows = signal<Record<string, OAuthFlowState>>({});
export const settings = signal<Settings | null>(null);
/** toasts shown bottom-right */
export const toasts = signal<{ id: number; text: string; level: 'info' | 'success' | 'warn' | 'error' }[]>([]);

export const unreadNotifications = computed(() => notifications.value.filter((n) => !n.read).length);

let toastSeq = 0;
export function toast(text: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, text, level }];
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 4500);
}

/* ─────────── collection change fan-out (for useResource) ─────────── */

type Collection = Extract<ServerEvent, { type: 'data.changed' }>['collection'];
const changeListeners = new Map<Collection, Set<() => void>>();
export function onCollectionChanged(c: Collection, fn: () => void): () => void {
  if (!changeListeners.has(c)) changeListeners.set(c, new Set());
  changeListeners.get(c)!.add(fn);
  return () => changeListeners.get(c)!.delete(fn);
}

/* ─────────── socket wiring ─────────── */

let started = false;
export function startStore(): void {
  if (started) return;
  started = true;
  socket.onStatus((s) => {
    conn.value = s;
    if (s === 'open') void refreshBasics();
  });
  socket.on(handleEvent);
  socket.connect();
}

async function refreshBasics() {
  try {
    const [s, a, n, ap] = await Promise.all([
      api.get<Settings>('/settings'),
      api.get<ActivityEntry[]>('/activity?limit=80'),
      api.get<Notification[]>('/notifications'),
      api.get<ApprovalRequest[]>('/approvals'),
    ]);
    settings.value = s;
    activityLog.value = a;
    notifications.value = n;
    approvals.value = ap;
  } catch (e) {
    console.warn('refreshBasics failed', e);
  }
}

function handleEvent(ev: ServerEvent) {
  switch (ev.type) {
    case 'hello':
      health.value = ev.health;
      phase.value = ev.phase;
      break;
    case 'agent.phase':
      phase.value = ev.phase;
      phaseDetail.value = ev.detail;
      phaseSession.value = ev.sessionId;
      break;
    case 'metrics': {
      metrics.value = ev.metrics;
      const h = metricsHistory.value.length >= 120 ? metricsHistory.value.slice(1) : metricsHistory.value.slice();
      h.push(ev.metrics);
      metricsHistory.value = h;
      break;
    }
    case 'activity':
      activityLog.value = [ev.entry, ...activityLog.value].slice(0, 200);
      break;
    case 'notification':
      notifications.value = [ev.notification, ...notifications.value].slice(0, 200);
      toast(`${ev.notification.title}${ev.notification.body ? ' — ' + ev.notification.body : ''}`, ev.notification.level);
      if (ev.notification.level === 'warn' || ev.notification.level === 'error') void phoneNotify(ev.notification.title, ev.notification.body);
      break;
    case 'approval.request':
      approvals.value = [...approvals.value.filter((a) => a.id !== ev.request.id), ev.request];
      break;
    case 'approval.resolved':
      approvals.value = approvals.value.filter((a) => a.id !== ev.id);
      break;
    case 'oauth.progress':
      oauthFlows.value = { ...oauthFlows.value, [ev.flow.flowId]: ev.flow };
      break;
    case 'chat.done':
    case 'session.deleted':
      // usage/session-derived panels listen on 'sessions'; the core only sends session-level events for these
      window.setTimeout(() => changeListeners.get('sessions')?.forEach((fn) => fn()), 300);
      break;
    case 'data.changed':
      if (ev.collection === 'settings') void api.get<Settings>('/settings').then((s) => (settings.value = s));
      if (ev.collection === 'notifications') void api.get<Notification[]>('/notifications').then((n) => (notifications.value = n));
      changeListeners.get(ev.collection)?.forEach((fn) => fn());
      break;
  }
}

/* ─────────── hooks ─────────── */

/** subscribe to raw server events inside a component */
export function useServerEvent(fn: (ev: ServerEvent) => void, deps: unknown[] = []): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => socket.on((ev) => ref.current(ev)), deps);
}

export interface Resource<T> {
  data: T | undefined;
  /** load error — only set when there is no data to show (see refreshError) */
  error: string | undefined;
  /** a fetch is in flight (also true while revalidating cached data) */
  loading: boolean;
  /** a fetch is in flight while (possibly cached) data is already shown */
  refreshing: boolean;
  /** the last background refresh failed; `data` is the previous (cached) value */
  refreshError: string | undefined;
  reload: () => Promise<void>;
  setData: (v: T | undefined) => void;
}

/* ─────────── stale-while-revalidate resource cache ─────────── */

interface CacheEntry {
  data: unknown;
  hasData: boolean;
  error: string | undefined;
  inflight: Promise<void> | null;
  /** a refetch was requested while one was in flight — run once more afterwards */
  again: boolean;
  /** time of the last successful fetch */
  at: number;
}

const CACHE_MAX = 100;
const SS_PREFIX = 'monarch.rc:';
const SS_MAX_ENTRY = 256 * 1024; // chars
const SS_MAX_KEYS = 40;
/** insertion order = LRU order (Map iteration order); re-set on access */
const cache = new Map<string, CacheEntry>();
const pathSubs = new Map<string, Set<() => void>>();

function ssKeys(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(SS_PREFIX)) out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}

function ssRead(path: string): { data: unknown; at: number } | null {
  try {
    const raw = sessionStorage.getItem(SS_PREFIX + path);
    return raw ? (JSON.parse(raw) as { data: unknown; at: number }) : null;
  } catch {
    return null;
  }
}

function ssWrite(path: string, data: unknown, at: number): void {
  try {
    const raw = JSON.stringify({ data, at });
    if (raw.length > SS_MAX_ENTRY) {
      sessionStorage.removeItem(SS_PREFIX + path);
      return;
    }
    const keys = ssKeys();
    if (keys.length >= SS_MAX_KEYS && !keys.includes(SS_PREFIX + path)) {
      // drop the oldest persisted entry
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const k of keys) {
        try {
          const at2 = (JSON.parse(sessionStorage.getItem(k) ?? '{}') as { at?: number }).at ?? 0;
          if (at2 < oldestAt) (oldestAt = at2), (oldest = k);
        } catch {
          oldest = k;
          break;
        }
      }
      if (oldest) sessionStorage.removeItem(oldest);
    }
    sessionStorage.setItem(SS_PREFIX + path, raw);
  } catch {
    /* quota / disabled storage — memory cache still works */
  }
}

function entryFor(path: string): CacheEntry {
  let e = cache.get(path);
  if (e) {
    cache.delete(path); // bump LRU
    cache.set(path, e);
    return e;
  }
  const persisted = ssRead(path);
  e = { data: persisted?.data, hasData: !!persisted, error: undefined, inflight: null, again: false, at: persisted?.at ?? 0 };
  cache.set(path, e);
  while (cache.size > CACHE_MAX) {
    const victim = [...cache.keys()].find((k) => !pathSubs.get(k)?.size && !cache.get(k)?.inflight);
    if (!victim) break;
    cache.delete(victim);
  }
  return e;
}

function notifyPath(path: string): void {
  pathSubs.get(path)?.forEach((fn) => fn());
}

function fetchPath(path: string, force = false): Promise<void> {
  const e = entryFor(path);
  if (e.inflight) {
    if (force) e.again = true;
    return e.inflight;
  }
  const p = (async () => {
    try {
      const d = await api.get<unknown>(path);
      e.data = d;
      e.hasData = true;
      e.error = undefined;
      e.at = Date.now();
      ssWrite(path, d, e.at);
    } catch (err: any) {
      e.error = err?.message ?? String(err);
    } finally {
      e.inflight = null;
      if (e.again) {
        e.again = false;
        void fetchPath(path);
      } else notifyPath(path);
    }
  })();
  e.inflight = p;
  notifyPath(path);
  return p;
}

function setPathData(path: string, v: unknown): void {
  const e = entryFor(path);
  e.data = v;
  e.hasData = v !== undefined;
  if (v !== undefined) {
    e.error = undefined;
    e.at = Date.now();
    ssWrite(path, v, e.at);
  }
  notifyPath(path);
}

/**
 * Refetch every cached resource whose path starts with one of `prefixes` (mounted views update in
 * place; unmounted entries are marked stale so they revalidate on next mount — they always do anyway).
 */
export function invalidateResources(...prefixes: string[]): void {
  for (const k of [...cache.keys()]) {
    if (!prefixes.some((p) => k.startsWith(p))) continue;
    if (pathSubs.get(k)?.size) void fetchPath(k, true);
  }
}

/**
 * Fetch `path` from the core REST API; refetch automatically when any of `collections` changes
 * (data.changed event), when the socket reconnects, and when `path` changes. Pass null to skip.
 *
 * Stale-while-revalidate: results are cached per path (memory LRU + small sessionStorage mirror),
 * so a remount/path switch returns the cached value immediately (`refreshing` true) while a
 * background refetch runs. A failed refetch keeps the cached data and sets `refreshError`.
 */
export function useResource<T>(path: string | null, collections: Collection[] = [], opts: { intervalMs?: number } = {}): Resource<T> {
  const [, force] = useState(0);
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    if (!path) return;
    const rerender = () => force((n) => n + 1);
    if (!pathSubs.has(path)) pathSubs.set(path, new Set());
    pathSubs.get(path)!.add(rerender);
    const reloadNow = () => void fetchPath(path);
    reloadNow();
    const offs = collections.map((c) => onCollectionChanged(c, () => void fetchPath(path, true)));
    const offConn = socket.onStatus((s) => s === 'open' && reloadNow());
    const iv = opts.intervalMs ? window.setInterval(reloadNow, opts.intervalMs) : undefined;
    return () => {
      pathSubs.get(path)?.delete(rerender);
      offs.forEach((o) => o());
      offConn();
      if (iv) window.clearInterval(iv);
    };
  }, [path, collections.join(','), opts.intervalMs]);

  const reload = useCallback(async () => {
    const p = pathRef.current;
    if (p) await fetchPath(p, true);
  }, []);
  const setData = useCallback((v: T | undefined) => {
    const p = pathRef.current;
    if (p) setPathData(p, v);
  }, []);

  if (!path) return { data: undefined, error: undefined, loading: false, refreshing: false, refreshError: undefined, reload, setData };
  const e = entryFor(path);
  // a mount always revalidates: report loading from the first render, before the effect has run
  const loading = !!e.inflight || !pathSubs.get(path)?.size;
  return {
    data: e.hasData ? (e.data as T) : undefined,
    error: e.hasData ? undefined : e.error,
    loading,
    refreshing: loading && e.hasData,
    refreshError: e.hasData ? e.error : undefined,
    reload,
    setData,
  };
}

/** current hash route, e.g. "#/comms/abc" -> ["comms","abc"] */
export const route = signal<string[]>(parseHash());
function parseHash(): string[] {
  const h = location.hash.replace(/^#\/?/, '');
  return h ? h.split('/').map(decodeURIComponent) : ['overview'];
}
window.addEventListener('hashchange', () => (route.value = parseHash()));
export function navigate(path: string): void {
  location.hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
}

/* ─────────── Android app: alerts as phone notifications ─────────── */

const inMobileApp = () => !!(window as any).__TAURI_INTERNALS__ && /Android|iPhone|iPad/i.test(navigator.userAgent);
let notifyAllowed: Promise<boolean> | null = null;

/** Only inside the Monarch Android app (Tauri notification plugin); a no-op in browsers and on desktop. */
async function phoneNotify(title: string, body: string): Promise<void> {
  if (!inMobileApp()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    notifyAllowed ??= invoke<boolean>('plugin:notification|is_permission_granted').then(async (ok) => ok || (await invoke<string>('plugin:notification|request_permission')) === 'granted');
    if (await notifyAllowed) await invoke('plugin:notification|notify', { options: { title, body } });
  } catch {
    /* plugin unavailable: the in-app toast already showed it */
  }
}
