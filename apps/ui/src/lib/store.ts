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
  error: string | undefined;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (v: T | undefined) => void;
}

/**
 * Fetch `path` from the core REST API; refetch automatically when any of `collections` changes
 * (data.changed event), when the socket reconnects, and when `path` changes. Pass null to skip.
 */
export function useResource<T>(path: string | null, collections: Collection[] = [], opts: { intervalMs?: number } = {}): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(!!path);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    setLoading(true);
    try {
      const d = await api.get<T>(p);
      if (pathRef.current === p) {
        setData(d);
        setError(undefined);
      }
    } catch (e: any) {
      if (pathRef.current === p) setError(e?.message ?? String(e));
    } finally {
      if (pathRef.current === p) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    void reload();
    const offs = collections.map((c) => onCollectionChanged(c, () => void reload()));
    const offConn = socket.onStatus((s) => s === 'open' && void reload());
    const iv = opts.intervalMs ? window.setInterval(() => void reload(), opts.intervalMs) : undefined;
    return () => {
      offs.forEach((o) => o());
      offConn();
      if (iv) window.clearInterval(iv);
    };
  }, [path, collections.join(','), opts.intervalMs]);

  return { data, error, loading, reload, setData };
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
