/**
 * Shared HUD primitives. OWNED BY THE ORCHESTRATOR — builders may ADD components, not change existing props.
 * Visual language: dark surfaces, 1px #323236 lines, mono uppercase labels, red (#D71921) used sparingly
 * for "active / attention" only. No glows, no gradients beyond the faint grid.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

type Tone = 'default' | 'red' | 'ok' | 'warn' | 'plain';

export function Panel(props: {
  code?: string; // "ENV.01"
  title: string; // "Local conditions"
  right?: ComponentChildren; // usually <Tag/>
  active?: boolean;
  class?: string;
  bodyClass?: string;
  noPad?: boolean;
  children?: ComponentChildren;
}) {
  return (
    <section class={`hud-panel ${props.class ?? ''}`} data-active={props.active ? 'true' : 'false'}>
      <header class="hud-head">
        {props.code && <span class="hud-code">{props.code}</span>}
        <h2 class="hud-title">{props.title}</h2>
        <div class="ml-auto flex items-center gap-2">{props.right}</div>
      </header>
      <div class={props.noPad ? `flex-1 min-h-0 ${props.bodyClass ?? ''}` : `hud-body ${props.bodyClass ?? ''}`}>{props.children}</div>
    </section>
  );
}

export function Tag(props: { tone?: Tone; children: ComponentChildren; title?: string; class?: string }) {
  return (
    <span class={`hud-tag ${props.class ?? ''}`} data-tone={props.tone ?? 'default'} title={props.title}>
      {props.children}
    </span>
  );
}

/** segmented bar meter, value 0..100 */
export function SegBar(props: { value: number; segments?: number; tone?: 'default' | 'red' | 'warn' | 'fg'; class?: string }) {
  const n = props.segments ?? 24;
  const on = Math.round((Math.max(0, Math.min(100, props.value)) / 100) * n);
  return (
    <div class={`hud-seg ${props.class ?? ''}`} data-tone={props.tone ?? 'default'}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} data-on={i < on ? 'true' : 'false'} />
      ))}
    </div>
  );
}

/** label over value, used in small stat grids */
export function Stat(props: { label: string; value: ComponentChildren; sub?: ComponentChildren; class?: string }) {
  return (
    <div class={props.class}>
      <div class="hud-label">{props.label}</div>
      <div class="hud-value text-sm mt-1">{props.value}</div>
      {props.sub && <div class="text-[11px] text-fg-3 mt-0.5 font-mono">{props.sub}</div>}
    </div>
  );
}

/** tiny inline sparkline/area chart (SVG). values arbitrary scale. */
export function Sparkline(props: {
  values: number[];
  height?: number;
  stroke?: string;
  fill?: string;
  class?: string;
  min?: number;
  max?: number;
}) {
  const h = props.height ?? 48;
  const w = 300;
  const vals = props.values.length ? props.values : [0];
  const min = props.min ?? Math.min(...vals);
  const max = props.max ?? Math.max(...vals);
  const span = max - min || 1;
  const step = vals.length > 1 ? w / (vals.length - 1) : w;
  const pts = vals.map((v, i) => [i * step, h - 2 - ((v - min) / span) * (h - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" class={`w-full ${props.class ?? ''}`} style={{ height: `${h}px` }}>
      <path d={area} fill={props.fill ?? 'rgb(244 244 246 / 0.05)'} />
      <path d={line} fill="none" stroke={props.stroke ?? '#9E9EA4'} stroke-width="1.25" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

export function Empty(props: { children: ComponentChildren; class?: string }) {
  return <div class={`text-fg-3 text-xs font-mono uppercase tracking-widest py-6 text-center ${props.class ?? ''}`}>{props.children}</div>;
}

export function Spinner(props: { class?: string }) {
  return <span class={`loading loading-spinner loading-xs text-fg-3 ${props.class ?? ''}`} />;
}

export function ErrorLine(props: { error?: string }) {
  if (!props.error) return null;
  return <div class="text-xs font-mono text-red px-1 py-2">{props.error}</div>;
}

/** red status dot (pulsing when live) */
export function Dot(props: { tone?: 'red' | 'ok' | 'warn' | 'muted'; pulse?: boolean }) {
  const c = { red: 'bg-red', ok: 'bg-success', warn: 'bg-warning', muted: 'bg-fg-3' }[props.tone ?? 'muted'];
  return <span class={`inline-block w-1.5 h-1.5 ${c} ${props.pulse ? 'hud-blink' : ''}`} />;
}

/** generic button styles (daisyUI btn, tuned) */
export function Btn(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'outline'; size?: 'xs' | 'sm' | 'md'; loading?: boolean },
) {
  const { variant = 'outline', size = 'sm', loading, class: cls, children, ...rest } = props as any;
  const v =
    variant === 'primary'
      ? 'btn-primary'
      : variant === 'ghost'
        ? 'btn-ghost text-fg-2 hover:text-fg'
        : 'btn-outline border-line text-fg-2 hover:bg-subtle hover:border-fg-3 hover:text-fg';
  return (
    <button
      {...rest}
      class={`btn btn-${size} ${v} font-mono uppercase tracking-wider text-[11px] font-normal rounded-[2px] ${cls ?? ''}`}
      disabled={rest.disabled || loading}
    >
      {loading && <span class="loading loading-spinner loading-xs" />}
      {children}
    </button>
  );
}

/** live clock hook */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/* ─────────── formatting helpers ─────────── */

export const fmt = {
  bytes(n: number, digits = 1): string {
    if (!isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
  },
  pct(n: number): string {
    return `${Math.round(n)}%`;
  },
  time(d: string | Date): string {
    return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  },
  timeSec(d: string | Date): string {
    return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  },
  date(d: string | Date): string {
    return new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  },
  dateTime(d: string | Date): string {
    return `${fmt.date(d)} ${fmt.time(d)}`;
  },
  /** "3m ago", "2h ago", "Mon" */
  ago(d: string | Date): string {
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
    return fmt.date(d);
  },
  /** countdown "T-01:23:45" until a date */
  countdown(d: string | Date, now = new Date()): string {
    let s = Math.max(0, Math.floor((new Date(d).getTime() - now.getTime()) / 1000));
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    return `T-${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  },
  num(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  },
  usd(n: number): string {
    return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  },
  uptime(sec: number): string {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return d ? `${d}D ${h}H` : h ? `${h}H ${m}M` : `${m}M`;
  },
};
