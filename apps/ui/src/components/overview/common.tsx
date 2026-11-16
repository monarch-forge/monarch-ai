/** Shared bits for the overview HUD panels. OWNED BY UI-A. */
import type { ComponentChildren } from 'preact';
import { conn, type Resource } from '../../lib/store.ts';
import { Spinner } from '../ui.tsx';

/** centred muted state used inside panels (offline / loading / error / empty) */
export function PanelNote(props: { label: string; sub?: ComponentChildren; tone?: 'muted' | 'red'; spinner?: boolean; action?: ComponentChildren }) {
  return (
    <div class="h-full min-h-[64px] flex flex-col items-center justify-center gap-1 text-center px-3 py-4">
      <div class={`flex items-center gap-2 text-[13px] ${props.tone === 'red' ? 'text-[#f0686d]' : 'text-fg-2'}`}>
        {props.spinner && <Spinner />}
        {props.label}
      </div>
      {props.sub && <div class="text-[12px] text-fg-3 max-w-[34ch] leading-snug">{props.sub}</div>}
      {props.action}
    </div>
  );
}

export function Offline() {
  return <PanelNote label={conn.value === 'connecting' ? 'Connecting…' : 'Monarch is offline'} sub={conn.value === 'connecting' ? undefined : 'This fills in again once the core is back.'} spinner={conn.value === 'connecting'} />;
}

/**
 * Render resource data, or the right muted state. Stale data is kept on screen while offline.
 */
export function Gate<T>(props: { res: Resource<T>; children: (data: T) => ComponentChildren; errorAction?: ComponentChildren }) {
  const { data, error, loading } = props.res;
  if (data !== undefined && data !== null) return <>{props.children(data)}</>;
  if (conn.value !== 'open') return <Offline />;
  if (error) return <PanelNote label="Couldn't load this" sub={error} action={props.errorAction ?? <RetryLink onClick={() => void props.res.reload()} />} />;
  if (loading) return <PanelNote label="Loading…" spinner />;
  return <PanelNote label="Nothing here yet" />;
}

export function RetryLink(props: { onClick: () => void; label?: string }) {
  return (
    <button type="button" class="mt-1 text-[12.5px] text-fg-2 hover:text-fg underline decoration-fg-3/50 underline-offset-4" onClick={props.onClick}>
      {props.label ?? 'Retry'}
    </button>
  );
}

/** tiny label/value pair */
export function KV(props: { k: string; v: ComponentChildren; class?: string }) {
  return (
    <div class={`min-w-0 ${props.class ?? ''}`}>
      <div class="hud-label text-[11px]">{props.k}</div>
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
