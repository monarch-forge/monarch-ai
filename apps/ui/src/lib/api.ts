/**
 * REST + WebSocket client for the Monarch core. OWNED BY THE ORCHESTRATOR — add helpers, don't change signatures.
 */
import { CORE_HOST, CORE_PORT, type ClientCommand, type ServerEvent } from '@monarch/shared';

const envBase = (import.meta.env.VITE_CORE_URL as string | undefined) ?? '';
export const CORE_URL = envBase || `http://${CORE_HOST}:${CORE_PORT}`;
export const WS_URL = CORE_URL.replace(/^http/, 'ws') + '/ws';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${CORE_URL}/api${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Core offline');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, (data as any)?.error ?? res.statusText);
  return data as T;
}
function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** build a query string, skipping empty values */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/* ─────────────── WebSocket ─────────────── */

type Listener = (ev: ServerEvent) => void;

class CoreSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: 'connecting' | 'open' | 'closed') => void>();
  private queue: ClientCommand[] = [];
  private retry = 0;
  private pingTimer: number | undefined;

  connect(): void {
    if (this.ws && this.ws.readyState <= 1) return;
    this.emitStatus('connecting');
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.emitStatus('open');
      for (const c of this.queue.splice(0)) ws.send(JSON.stringify(c));
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping', t: Date.now() }), 20000);
    };
    ws.onmessage = (m) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(m.data as string);
      } catch {
        return;
      }
      for (const l of this.listeners) {
        try {
          l(ev);
        } catch (e) {
          console.error(e);
        }
      }
    };
    ws.onclose = () => {
      this.emitStatus('closed');
      window.clearInterval(this.pingTimer);
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      window.setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  send(cmd: ClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
    else if (cmd.type !== 'ping') this.queue.push(cmd);
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: (s: 'connecting' | 'open' | 'closed') => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  private emitStatus(s: 'connecting' | 'open' | 'closed') {
    for (const l of this.statusListeners) l(s);
  }
}

export const socket = new CoreSocket();

/** open a URL in the system browser (Tauri) or a new tab (web) */
export async function openExternal(url: string): Promise<void> {
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_external', { url });
      return;
    } catch {
      /* fall through */
    }
  }
  window.open(url, '_blank', 'noopener');
}
