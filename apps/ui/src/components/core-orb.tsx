/**
 * Core orb — a calm centrepiece: a soft halo, a 24-hour usage ring and a centre readout driven by the agent
 * phase. Grey and still while idle; one arc turns while working; red only when something needs the user.
 * ringText / leftLabels / rightLabels are accepted for compatibility but no longer drawn.
 * OWNED BY UI-A.
 */
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AgentPhase } from '@monarch/shared';
import { approvals, conn, phase, phaseDetail } from '../lib/store.ts';
import { useNow } from './ui.tsx';

const C = {
  line: '#323236',
  subtle: '#262629',
  fg: '#F4F4F6',
  fg2: '#9E9EA4',
  fg3: '#5E5E64',
  red: '#D71921',
};

export type OrbState = AgentPhase | 'offline';

/** ask the approval dock (UI-B) to take focus */
export function focusApprovals(): void {
  window.dispatchEvent(new CustomEvent('monarch:focus-approvals'));
  const el = document.querySelector<HTMLElement>('[data-approval-dock] button, [data-approval-dock]');
  el?.focus();
  el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const pt = (cx: number, cy: number, r: number, deg: number) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))] as const;
/** svg arc path from a1 → a2 (degrees, clockwise, 0° = 3 o'clock) */
function arc(cx: number, cy: number, r: number, a1: number, a2: number): string {
  const [x1, y1] = pt(cx, cy, r, a1);
  const [x2, y2] = pt(cx, cy, r, a2);
  const large = (((a2 - a1) % 360) + 360) % 360 > 180 ? 1 : 0;
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r.toFixed(2)},${r.toFixed(2)} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize((s) => (Math.abs(s.w - width) < 1 && Math.abs(s.h - height) < 1 ? s : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export interface CoreOrbProps {
  /** 24 values 0..1 — token usage per hour of the local day, drawn as the segmented ring */
  hourly?: number[];
  /** idle readout */
  idleValue?: string;
  idleSub?: string;
  /** text running along the upper-left arc */
  ringText?: string;
  /** leader-line labels: [upper, lower] for each side */
  leftLabels?: [string, string];
  rightLabels?: [string, string];
  class?: string;
}

export function CoreOrb(props: CoreOrbProps) {
  const [wrapRef, { w, h }] = useSize<HTMLDivElement>();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const now = useNow(1000);

  const online = conn.value === 'open';
  const ph = phase.value;
  const state: OrbState = online ? ph : 'offline';
  const working = state === 'thinking' || state === 'responding' || state === 'tool';
  const pendingCount = approvals.value.length;

  // elapsed time in the current phase
  const phaseStart = useRef<{ phase: OrbState; at: number }>({
    phase: state,
    at: Date.now(),
  });
  if (phaseStart.current.phase !== state) phaseStart.current = { phase: state, at: Date.now() };
  const elapsed = Math.max(0, Math.floor((now.getTime() - phaseStart.current.at) / 1000));

  // geometry
  const R0 = Math.max(0, Math.min(h / 2 - 8, w / 2 - 8));
  const R = R0;
  const cx = w / 2;
  const cy = h / 2;
  const ready = R > 40;

  const rHours = R * 0.86;
  const rSpin = R * 0.7;
  const rInner = R * 0.6;
  const hoursW = Math.max(3, R * 0.045);

  const hourNow = now.getHours();
  const hourly = props.hourly && props.hourly.length === 24 ? props.hourly : null;

  const spinStyle = working
    ? {
        transformOrigin: `${cx}px ${cy}px`,
        animation: 'hud-spin 6s linear infinite',
      }
    : { transformOrigin: `${cx}px ${cy}px` };

  // readout
  let label = 'Ready';
  let value: string = props.idleValue ?? '—';
  let sub: string = props.idleSub ?? '';
  let valueIsText = false;
  let valueTitle: string | undefined;
  if (state === 'offline') {
    label = conn.value === 'connecting' ? 'Connecting' : 'Offline';
    value = '—';
    sub = conn.value === 'connecting' ? 'one moment' : 'waiting for the core';
  } else if (state === 'thinking' || state === 'responding') {
    label = state === 'thinking' ? 'Thinking' : 'Responding';
    value = `${pad2(Math.floor(elapsed / 60))}:${pad2(elapsed % 60)}`;
    sub = phaseDetail.value ?? 'elapsed';
  } else if (state === 'tool') {
    label = 'Working';
    const detail = (phaseDetail.value ?? '').trim();
    value = detail.split(/[\s({:]/)[0]?.replace(/^mcp__[^_]+__/, '') || 'working';
    valueIsText = true;
    valueTitle = detail || undefined;
    sub = `${pad2(Math.floor(elapsed / 60))}:${pad2(elapsed % 60)}`;
  } else if (state === 'awaiting-approval') {
    label = 'Needs your OK';
    value = String(Math.max(1, pendingCount));
    sub = 'tap to review';
  } else if (state === 'error') {
    label = 'Something went wrong';
    value = '!';
    sub = phaseDetail.value ?? 'see Systems for details';
  }

  const valuePx = Math.max(18, Math.min(40, R * 0.22));
  const textPx = Math.max(12, Math.min(18, R * 0.075));
  const readoutW = rInner * 1.7;

  const attentionRed = state === 'awaiting-approval' || state === 'error';
  const ringOpacity = state === 'offline' ? 0.55 : 1;

  return (
    <div ref={wrapRef} class={`relative w-full h-full min-h-0 select-none ${props.class ?? ''}`}>
      {ready && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} class="absolute inset-0" aria-hidden="true" style={{ opacity: ringOpacity }}>
          <defs>
            <radialGradient id={`orbglow-${uid}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color={attentionRed ? C.red : C.fg} stop-opacity={attentionRed ? 0.1 : 0.045} />
              <stop offset="100%" stop-color={C.fg} stop-opacity="0" />
            </radialGradient>
          </defs>
          {/* soft halo */}
          <circle cx={cx} cy={cy} r={R} fill={`url(#orbglow-${uid})`} class={state === 'idle' ? 'orb-idle-ring' : ''} />

          {/* 24h usage ring: one soft arc per hour, the current hour gently red */}
          {Array.from({ length: 24 }, (_, i) => {
            const a1 = -90 + i * 15 + 2.4;
            const a2 = -90 + (i + 1) * 15 - 2.4;
            const v = hourly ? Math.max(0, Math.min(1, hourly[i] ?? 0)) : 0;
            const isNow = i === hourNow && state !== 'offline';
            return (
              <path
                key={i}
                d={arc(cx, cy, rHours, a1, a2)}
                fill="none"
                stroke-linecap="round"
                stroke={isNow ? C.red : v > 0 ? C.fg2 : C.subtle}
                stroke-opacity={isNow ? 0.85 : v > 0 ? 0.2 + 0.6 * v : 1}
                stroke-width={hoursW}
              >
                <title>{`${pad2(i)}:00`}</title>
              </path>
            );
          })}

          {/* a single arc that turns slowly while working */}
          <circle cx={cx} cy={cy} r={rSpin} fill="none" stroke={C.subtle} stroke-width="1" />
          <g style={spinStyle} class="spin-transition">
            <path
              d={arc(cx, cy, rSpin, -120, -60)}
              fill="none"
              stroke-linecap="round"
              stroke={working ? C.red : C.fg3}
              stroke-opacity={working ? 0.9 : 0.5}
              stroke-width="2"
            />
          </g>

          {/* core */}
          <circle
            cx={cx}
            cy={cy}
            r={rInner}
            fill="#161618"
            stroke={attentionRed ? C.red : C.subtle}
            stroke-opacity={attentionRed ? 0.55 : 1}
            stroke-width="1"
          />
        </svg>
      )}

      {ready && (
        <Readout
          x={cx}
          y={cy}
          width={readoutW}
          label={label}
          value={value}
          sub={sub}
          valuePx={valueIsText ? textPx : valuePx}
          valueIsText={valueIsText}
          valueTitle={valueTitle}
          state={state}
          working={working}
        />
      )}
    </div>
  );
}

function Readout(props: {
  x: number;
  y: number;
  width: number;
  label: string;
  value: string;
  sub: string;
  valuePx: number;
  valueIsText: boolean;
  valueTitle?: string;
  state: OrbState;
  working: boolean;
}) {
  const attention = props.state === 'awaiting-approval';
  const red = attention || props.state === 'error' || props.working;
  const content = (
    <>
      <div
        class={`flex items-center gap-1.5 text-[12px] font-medium ${attention || props.state === 'error' ? 'text-[#f0686d]' : 'text-fg-2'}`}
      >
        {red && <span class={`inline-block w-1.5 h-1.5 rounded-full bg-red ${attention || props.working ? 'hud-blink' : ''}`} />}
        <span class="truncate">{props.label}</span>
      </div>
      <div
        class={`text-fg tabular-nums leading-none mt-1.5 max-w-full ${props.valueIsText ? 'truncate' : 'font-light tracking-tight'}`}
        style={{ fontSize: `${props.valuePx}px` }}
        title={props.valueTitle ?? (props.valueIsText ? props.value : undefined)}
      >
        {props.value}
      </div>
      {props.sub && <div class="text-[11px] text-fg-3 mt-1.5 max-w-full truncate">{props.sub}</div>}
    </>
  );
  const style = {
    left: `${props.x - props.width / 2}px`,
    top: `${props.y}px`,
    width: `${props.width}px`,
    transform: 'translateY(-50%)',
  };
  if (attention) {
    return (
      <button
        type="button"
        class="absolute flex flex-col items-center text-center px-2 py-1 cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
        style={style}
        onClick={focusApprovals}
        title="Review pending approval"
      >
        {content}
      </button>
    );
  }
  return (
    <div class="absolute flex flex-col items-center text-center pointer-events-none" style={style} role="status" aria-live="polite">
      {content}
    </div>
  );
}
