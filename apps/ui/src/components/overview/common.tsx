/** Shared bits for the overview HUD panels. OWNED BY UI-A. */
import type { ComponentChildren } from 'preact';
import { conn, type Resource } from '../../lib/store.ts';
import { Spinner } from '../ui.tsx';

/** centred muted state used inside panels (offline / loading / error / empty) */
export function PanelNote(props: { label: string; sub?: ComponentChildren; tone?: 'muted' | 'red'; spinner?: boolean; action?: ComponentChildren }) {
  return (
    <div class="h-full min-h-[64px] flex flex-col items-center justify-center gap-1.5 text-center px-3 py-4">
      <div class={`flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] uppercase ${props.tone === 'red' ? 'text-red' : 'text-fg-3'}`}>
        {props.spinner ? <Spinner /> : <span class={`inline-block w-1.5 h-1.5 border ${props.tone === 'red' ? 'border-red' : 'border-fg-3'}`} />}
        {props.label}
      </div>
      {props.sub && <div class="text-[11px] text-fg-3 max-w-[30ch] leading-snug">{props.sub}</div>}
      {props.action}
    </div>
  );
}

export function Offline() {
  return <PanelNote label={conn.value === 'connecting' ? 'Linking core' : 'Core offline'} sub={conn.value === 'connecting' ? undefined : 'Telemetry resumes when the core is reachable.'} spinner={conn.value === 'connecting'} />;
}

/**
 * Render resource data, or the right muted state. Stale data is kept on screen while offline.
 */
export function Gate<T>(props: { res: Resource<T>; children: (data: T) => ComponentChildren; errorAction?: ComponentChildren }) {
  const { data, error, loading } = props.res;
  if (data !== undefined && data !== null) return <>{props.children(data)}</>;
  if (conn.value !== 'open') return <Offline />;
  if (error) return <PanelNote label="Unavailable" sub={error} action={props.errorAction ?? <RetryLink onClick={() => void props.res.reload()} />} />;
  if (loading) return <PanelNote label="Loading" spinner />;
  return <PanelNote label="No data" />;
}

export function RetryLink(props: { onClick: () => void; label?: string }) {
  return (
    <button type="button" class="mt-1 font-mono text-[10px] tracking-[0.14em] uppercase text-fg-2 hover:text-fg underline decoration-line underline-offset-4" onClick={props.onClick}>
      {props.label ?? 'Retry'}
    </button>
  );
}

/** tiny mono label/value pair */
export function KV(props: { k: string; v: ComponentChildren; class?: string }) {
  return (
    <div class={`min-w-0 ${props.class ?? ''}`}>
      <div class="hud-label text-[10px]">{props.k}</div>
      <div class="hud-value text-[13px] mt-0.5 truncate">{props.v}</div>
    </div>
  );
}

export function tone85(pct: number): 'default' | 'red' {
  return pct >= 85 ? 'red' : 'default';
}

export function startOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function endOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
export function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
