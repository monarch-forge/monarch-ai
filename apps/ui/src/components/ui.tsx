/**
 * Shared primitives. Builders may ADD components, not change existing props.
 * Visual language ("calm study", see docs/DESIGN.md): soft surface cards, space instead of lines,
 * sentence-case sans titles, red (#D71921) only for "act" or "attention".
 */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

type Tone = 'default' | 'red' | 'ok' | 'warn' | 'plain';

export function Panel(props: {
  code?: string; // accepted for compatibility, no longer rendered
  title: string; // "Local conditions"
  right?: ComponentChildren; // usually <Tag/>
  active?: boolean;
  class?: string;
  bodyClass?: string;
  noPad?: boolean;
  children?: ComponentChildren;
}) {
  return (
    <section class={`hud-panel ${props.active ? 'ring-1 ring-red/25' : ''} ${props.class ?? ''}`} data-active={props.active ? 'true' : 'false'}>
      <header class="hud-head">
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
      <div class="hud-value text-[15px] font-medium mt-0.5">{props.value}</div>
      {props.sub && <div class="text-[11px] text-fg-3 mt-0.5">{props.sub}</div>}
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
      <path d={line} fill="none" stroke={props.stroke ?? '#A3A3A9'} stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

export function Empty(props: { children: ComponentChildren; class?: string }) {
  return <div class={`text-fg-2 text-[13px] py-8 px-4 text-center ${props.class ?? ''}`}>{props.children}</div>;
}

export function Spinner(props: { class?: string }) {
  return <span class={`loading loading-spinner loading-xs text-fg-3 ${props.class ?? ''}`} />;
}

export function ErrorLine(props: { error?: string }) {
  if (!props.error) return null;
  return <div class="text-[12.5px] text-[#f0686d] bg-red/10 rounded-md px-3 py-2 my-1">{props.error}</div>;
}

/** red status dot (pulsing when live) */
export function Dot(props: { tone?: 'red' | 'ok' | 'warn' | 'muted'; pulse?: boolean }) {
  const c = { red: 'bg-red', ok: 'bg-success', warn: 'bg-warning', muted: 'bg-fg-3' }[props.tone ?? 'muted'];
  return <span class={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${c} ${props.pulse ? 'hud-blink' : ''}`} />;
}

/** generic button styles (daisyUI btn, tuned) */
export function Btn(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'outline' | 'danger'; size?: 'xs' | 'sm' | 'md'; loading?: boolean },
) {
  const { variant = 'outline', size = 'sm', loading, class: cls, children, ...rest } = props as any;
  const v =
    variant === 'primary'
      ? 'btn-primary border-transparent hover:bg-red-hover'
      : variant === 'danger'
        ? 'btn-error border-transparent'
        : variant === 'ghost'
        ? 'btn-ghost text-fg-2 hover:text-fg'
        : 'btn-ghost bg-raised border-transparent text-fg-2 hover:bg-subtle hover:text-fg';
  return (
    <button
      {...rest}
      class={`btn btn-${size} ${v} text-[12.5px] font-medium rounded-md shadow-none transition-colors duration-150 ${cls ?? ''}`}
      disabled={rest.disabled || loading}
    >
      {loading && <span class="loading loading-spinner loading-xs" />}
      {children}
    </button>
  );
}

/** page title + muted description, with optional actions on the right */
export function PageHeader(props: { title: ComponentChildren; description?: ComponentChildren; right?: ComponentChildren; class?: string }) {
  return (
    <header class={`flex items-start gap-4 ${props.class ?? ''}`}>
      <div class="min-w-0 flex-1">
        <h1 class="text-[20px] font-semibold tracking-[-0.01em] text-fg leading-tight">{props.title}</h1>
        {props.description && <p class="mt-1 text-[13px] text-fg-3 leading-relaxed">{props.description}</p>}
      </div>
      {props.right && <div class="flex items-center gap-2 shrink-0">{props.right}</div>}
    </header>
  );
}

/** progressive disclosure ("Advanced", "Details", "More"): native <details>, calm chevron */
export function Disclosure(props: { label?: ComponentChildren; open?: boolean; class?: string; bodyClass?: string; children: ComponentChildren }) {
  return (
    <details class={`group ${props.class ?? 'mt-2'}`} open={props.open}>
      <summary class="list-none cursor-pointer select-none inline-flex items-center gap-1.5 text-[12.5px] text-fg-3 hover:text-fg-2 py-1 transition-colors [&::-webkit-details-marker]:hidden">
        <span class="inline-block transition-transform duration-150 group-open:rotate-90">›</span>
        {props.label ?? 'Advanced'}
      </summary>
      <div class={props.bodyClass ?? 'flex flex-col gap-4 pt-3'}>{props.children}</div>
    </details>
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

/* ───────────── design system (v0.16 UI refactor): use these on every page ───────────── */

/** Nothing-style dot-matrix text: numbers, clock, short headlines only */
export function DotText(props: { children: ComponentChildren; class?: string; title?: string }) {
  return (
    <span class={`ds-dot ${props.class ?? ''}`} title={props.title}>
      {props.children}
    </span>
  );
}

/** glyph light strip (Nothing Glyph-style): `value` lit segments of `of`; live = gentle pulse */
export function Glyph(props: { value: number; of?: number; tone?: 'fg' | 'red' | 'warn'; live?: boolean; class?: string; title?: string }) {
  const n = props.of ?? 5;
  const on = Math.max(0, Math.min(n, Math.round(props.value)));
  return (
    <span class={`ds-glyph ${props.class ?? ''}`} data-tone={props.tone ?? 'fg'} data-live={props.live ? 'true' : 'false'} title={props.title} aria-hidden={props.title ? undefined : true}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} data-on={i < on ? 'true' : 'false'} />
      ))}
    </span>
  );
}

/** pill tabs (segmented): one style for every tab/segment switch in the app */
export function Pills<T extends string>(props: { value: T; options: { value: T; label: ComponentChildren; title?: string }[]; onChange: (v: T) => void; class?: string; size?: 'sm' | 'md' }) {
  const h = props.size === 'md' ? 'h-8 px-3 text-[13px]' : 'h-7 px-2.5 text-[12.5px]';
  return (
    <div role="tablist" class={`inline-flex items-center gap-0.5 p-0.5 rounded-[10px] bg-[#121213] border border-line ${props.class ?? ''}`}>
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            title={o.title}
            class={`${h} rounded-[8px] inline-flex items-center gap-1.5 transition-colors duration-150 ${on ? 'bg-raised text-fg' : 'text-fg-3 hover:text-fg-2'}`}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** list row: icon/lead · title + sub · trailing meta; clickable when onClick/href given */
export function ListRow(props: {
  lead?: ComponentChildren;
  title: ComponentChildren;
  sub?: ComponentChildren;
  trail?: ComponentChildren;
  onClick?: () => void;
  href?: string;
  active?: boolean;
  class?: string;
  /** keyboard cursor highlight (j/k lists), softer than `active` */
  focused?: boolean;
  /** red accent bar on the left when active */
  marker?: boolean;
  /** top-align lead/trail for multi-line rows */
  top?: boolean;
  /** extra attributes (role, aria-*, data-*, title) for the row element */
  attrs?: Record<string, unknown>;
}) {
  const cls = `group relative flex ${props.top ? 'items-start' : 'items-center'} gap-3 px-3 py-2.5 rounded-[var(--radius-control)] transition-colors ${props.active ? 'bg-raised' : props.focused ? 'bg-white/[0.035]' : 'hover:bg-white/[0.03]'} ${props.onClick || props.href ? 'cursor-pointer' : ''} ${props.class ?? ''}`;
  const body = (
    <>
      {props.marker && props.active && <span class="absolute left-0 top-3 bottom-3 w-[2px] rounded-full bg-red" />}
      {props.lead && <span class="shrink-0 text-fg-3">{props.lead}</span>}
      <span class="flex-1 min-w-0">
        <span class="block text-[13.5px] text-fg truncate">{props.title}</span>
        {props.sub && <span class="block text-[12px] text-fg-3 truncate mt-0.5">{props.sub}</span>}
      </span>
      {props.trail && <span class="shrink-0 flex items-center gap-2 text-[12px] text-fg-3">{props.trail}</span>}
    </>
  );
  return props.href ? (
    <a href={props.href} class={cls} {...(props.attrs as any)}>
      {body}
    </a>
  ) : (
    <div
      class={cls}
      onClick={props.onClick}
      onKeyDown={props.onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), props.onClick!()) : undefined}
      role={props.onClick ? 'button' : undefined}
      tabIndex={props.onClick ? 0 : undefined}
      {...(props.attrs as any)}
    >
      {body}
    </div>
  );
}

/** empty state that teaches: icon, one-line title, short hint, 1–2 actions */
export function EmptyState(props: { icon?: ComponentChildren; title: ComponentChildren; hint?: ComponentChildren; actions?: ComponentChildren; class?: string }) {
  return (
    <div class={`flex flex-col items-center justify-center text-center gap-2 px-6 py-10 ${props.class ?? ''}`}>
      {props.icon && <div class="w-10 h-10 rounded-full bg-raised grid place-items-center text-fg-3 mb-1">{props.icon}</div>}
      <div class="text-[14px] font-medium text-fg">{props.title}</div>
      {props.hint && <div class="text-[12.5px] text-fg-3 max-w-[340px] leading-relaxed">{props.hint}</div>}
      {props.actions && <div class="flex flex-wrap justify-center gap-2 mt-2">{props.actions}</div>}
    </div>
  );
}

/** skeleton placeholder: `lines` bars, or a block when `h` is given — use instead of spinners for first loads */
export function Skeleton(props: { lines?: number; h?: number; class?: string }) {
  if (props.h) return <div class={`ds-skeleton ${props.class ?? ''}`} style={{ height: `${props.h}px` }} aria-hidden="true" />;
  const n = props.lines ?? 3;
  return (
    <div class={`flex flex-col gap-2 ${props.class ?? ''}`} aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} class="ds-skeleton h-3" style={{ width: `${i === n - 1 ? 60 : 100 - i * 8}%` }} />
      ))}
    </div>
  );
}

/** side drawer (narrow layouts): overlay + panel sliding from left/right; Esc / backdrop closes */
export function Drawer(props: { open: boolean; onClose: () => void; side?: 'left' | 'right'; width?: string; title?: ComponentChildren; children: ComponentChildren }) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open]);
  if (!props.open) return null;
  const left = props.side === 'left';
  return (
    <div class="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div class="absolute inset-0 bg-black/45 animate-monarch-fade" onClick={props.onClose} />
      <aside
        class={`ds-drawer-enter absolute top-0 bottom-0 ${left ? 'left-0' : 'right-0'} ${props.width ?? 'w-[300px] max-w-[85vw]'} bg-surface shadow-[var(--shadow-pop)] flex flex-col`}
        style={{ ['--ds-drawer-from' as string]: left ? '-100%' : '100%' }}
      >
        {props.title && <div class="px-4 h-12 flex items-center text-[14px] font-semibold text-fg shrink-0">{props.title}</div>}
        <div class="flex-1 min-h-0 overflow-y-auto">{props.children}</div>
      </aside>
    </div>
  );
}
