/**
 * Core orb — the agent's visual "reactor": concentric thin rings, a 24-hour usage ring, tick marks,
 * optional leader lines out to the side panels, and a centre readout driven by the agent phase.
 * Calm by design: grey and static while idle; one ring turns slowly (with a single red arc) while working.
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

  // geometry — leave horizontal room for leader lines when there is space
  const hasLeaders = !!(props.leftLabels || props.rightLabels);
  const R0 = Math.max(0, Math.min(h / 2 - 8, w / 2 - 8));
  const leaderRoom = hasLeaders && w - 2 * R0 >= 150;
  const R = R0;
  const cx = w / 2;
  const cy = h / 2;
  const ready = R > 40;

  const rTick = R;
  const rText = R * 0.9;
  const rHours = R * 0.78;
  const rSpin = R * 0.655;
  const rDash = R * 0.585;
  const rInner = R * 0.5;
  const hoursW = Math.max(4, R * 0.075);

  const hourNow = now.getHours();
  const hourly = props.hourly && props.hourly.length === 24 ? props.hourly : null;

  const spinStyle = working
    ? {
        transformOrigin: `${cx}px ${cy}px`,
        animation: 'hud-spin 16s linear infinite',
      }
    : { transformOrigin: `${cx}px ${cy}px` };

  // readout
  let label = 'STANDBY';
  let value: string = props.idleValue ?? '—';
  let sub: string = props.idleSub ?? '';
  let valueIsText = false;
  let valueTitle: string | undefined;
  if (state === 'offline') {
    label = conn.value === 'connecting' ? 'LINKING' : 'CORE OFFLINE';
    value = '—';
    sub = conn.value === 'connecting' ? 'establishing uplink' : 'awaiting uplink';
  } else if (state === 'thinking' || state === 'responding') {
    label = state === 'thinking' ? 'THINKING' : 'RESPONDING';
    value = `${pad2(Math.floor(elapsed / 60))}:${pad2(elapsed % 60)}`;
    sub = phaseDetail.value ?? 'elapsed';
  } else if (state === 'tool') {
    label = 'TOOL CALL';
    const detail = (phaseDetail.value ?? '').trim();
    value = detail.split(/[\s({:]/)[0]?.replace(/^mcp__[^_]+__/, '') || 'working';
    valueIsText = true;
    valueTitle = detail || undefined;
    sub = `${pad2(Math.floor(elapsed / 60))}:${pad2(elapsed % 60)}`;
  } else if (state === 'awaiting-approval') {
    label = 'AWAITING APPROVAL';
    value = String(Math.max(1, pendingCount));
    sub = 'review →';
  } else if (state === 'error') {
    label = 'FAULT';
    value = 'ERR';
    sub = phaseDetail.value ?? 'see assistant log';
  }

  const valuePx = Math.max(18, Math.min(52, R * 0.2));
  const textPx = Math.max(12, Math.min(18, R * 0.075));
  const readoutW = rInner * 1.75;

  const tickColorMajor = state === 'offline' ? C.line : C.fg3;
  const ringOpacity = state === 'offline' ? 0.55 : 1;

  return (
    <div ref={wrapRef} class={`relative w-full h-full min-h-0 select-none ${props.class ?? ''}`}>
      {ready && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} class="absolute inset-0" aria-hidden="true" style={{ opacity: ringOpacity }}>
          <defs>
            <path id={`orbtext-${uid}`} d={arc(cx, cy, rText, 188, 300)} />
          </defs>

          {/* leader lines */}
          {leaderRoom && props.leftLabels && <Leaders side="left" cx={cx} cy={cy} R={R} w={w} labels={props.leftLabels} />}
          {leaderRoom && props.rightLabels && <Leaders side="right" cx={cx} cy={cy} R={R} w={w} labels={props.rightLabels} />}

          {/* outer tick ring */}
          <circle cx={cx} cy={cy} r={rTick} fill="none" stroke={C.subtle} stroke-width="1" />
          {Array.from({ length: 120 }, (_, i) => {
            const a = i * 3;
            const major = i % 10 === 0;
            const len = major ? R * 0.05 : R * 0.022;
            const [x1, y1] = pt(cx, cy, rTick, a);
            const [x2, y2] = pt(cx, cy, rTick - len, a);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={major ? tickColorMajor : C.line} stroke-width="1" />;
          })}

          {/* ring text */}
          {props.ringText && R > 110 && (
            <text fill={C.fg3} font-family="var(--font-mono)" font-size={Math.max(8, Math.min(10.5, R * 0.042))} letter-spacing="0.14em">
              <textPath href={`#orbtext-${uid}`}>{props.ringText.toUpperCase()}</textPath>
            </text>
          )}
          {/* small arc ornaments, lower-right */}
          <path d={arc(cx, cy, rText, 20, 70)} fill="none" stroke={C.line} stroke-width="1" />
          <path d={arc(cx, cy, rText, 74, 80)} fill="none" stroke={C.red} stroke-width="1.5" />

          {/* 24h usage ring */}
          {Array.from({ length: 24 }, (_, i) => {
            const a1 = -90 + i * 15 + 1.6;
            const a2 = -90 + (i + 1) * 15 - 1.6;
            const v = hourly ? Math.max(0, Math.min(1, hourly[i] ?? 0)) : 0;
            const isNow = i === hourNow && state !== 'offline';
            return (
              <path
                key={i}
                d={arc(cx, cy, rHours, a1, a2)}
                fill="none"
                stroke={isNow ? C.red : v > 0 ? C.fg2 : C.subtle}
                stroke-opacity={isNow ? 0.35 + 0.65 * Math.max(v, 0.4) : v > 0 ? 0.18 + 0.62 * v : 1}
                stroke-width={hoursW}
              >
                <title>{`${pad2(i)}:00`}</title>
              </path>
            );
          }).concat(
            state === 'offline'
              ? []
              : [
                  // current-hour marker: a small fg notch just outside the ring
                  (() => {
                    const a = -90 + hourNow * 15 + 7.5 + (now.getMinutes() / 60 - 0.5) * 11.8;
                    const [x1, y1] = pt(cx, cy, rHours + hoursW / 2 + 2, a);
                    const [x2, y2] = pt(cx, cy, rHours + hoursW / 2 + 2 + R * 0.035, a);
                    return <line key="now" x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.red} stroke-width="1.5" />;
                  })(),
                ],
          )}
          {/* hour labels */}
          {R > 120 &&
            [0, 6, 12, 18].map((hh) => {
              const [x, y] = pt(cx, cy, rHours - hoursW / 2 - R * 0.045, -90 + hh * 15 + 7.5);
              return (
                <text
                  key={hh}
                  x={x}
                  y={y}
                  fill={C.fg3}
                  font-family="var(--font-mono)"
                  font-size={Math.max(8, R * 0.036)}
                  text-anchor="middle"
                  dominant-baseline="central"
                >
                  {pad2(hh)}
                </text>
              );
            })}

          {/* rotating ring — turns only while working */}
          <circle cx={cx} cy={cy} r={rSpin} fill="none" stroke={C.line} stroke-width="1" class="spin-transition" />
          <g style={spinStyle} class="spin-transition">
            <path d={arc(cx, cy, rSpin, -120, -62)} fill="none" stroke={state === 'offline' ? C.fg3 : C.red} stroke-opacity={working ? 1 : 0.6} stroke-width="2.5" />
            <path d={arc(cx, cy, rSpin, 60, 74)} fill="none" stroke={C.fg3} stroke-width="2.5" />
            <path d={arc(cx, cy, rSpin, 150, 153)} fill="none" stroke={C.fg3} stroke-width="2.5" />
          </g>

          {/* dashed ring */}
          <circle
            cx={cx}
            cy={cy}
            r={rDash}
            fill="none"
            stroke={state === 'idle' ? C.red : C.line}
            stroke-opacity={state === 'idle' ? 0.35 : 1}
            stroke-width={Math.max(2, R * 0.012)}
            stroke-dasharray={`${(rDash * 0.06).toFixed(2)} ${(rDash * 0.045).toFixed(2)}`}
            class={`spin-transition ${state === 'idle' ? 'orb-idle-ring' : ''}`}
          />

          {/* crosshair ticks between dashed ring and core */}
          {[0, 90, 180, 270].map((a) => {
            const [x1, y1] = pt(cx, cy, rInner + 4, a);
            const [x2, y2] = pt(cx, cy, rDash - R * 0.03, a);
            return <line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke={a === 270 && state !== 'offline' ? C.red : C.fg3} stroke-width="1" />;
          })}

          {/* core */}
          <circle
            cx={cx}
            cy={cy}
            r={rInner}
            fill="#121213"
            stroke={state === 'awaiting-approval' || state === 'error' ? C.red : C.line}
            stroke-opacity={state === 'awaiting-approval' || state === 'error' ? 0.6 : 1}
            stroke-width="1"
          />
          <circle cx={cx} cy={cy} r={rInner - Math.max(4, R * 0.03)} fill="none" stroke={C.subtle} stroke-width="1" />
          {state !== 'offline' && (
            <path d={arc(cx, cy, rInner - Math.max(4, R * 0.03), -104, -76)} fill="none" stroke={C.red} stroke-width="1.5" />
          )}
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
        class={`flex items-center gap-1.5 font-mono text-[10px] tracking-[0.16em] uppercase ${attention || props.state === 'error' ? 'text-red' : 'text-fg-3'}`}
      >
        {red && <span class={`inline-block w-1.5 h-1.5 bg-red ${attention || props.working ? 'hud-blink' : ''}`} />}
        <span class="truncate">{props.label}</span>
      </div>
      <div
        class={`font-mono text-fg tabular-nums leading-none mt-2 max-w-full ${props.valueIsText ? 'truncate tracking-wide' : 'font-light tracking-tight'}`}
        style={{ fontSize: `${props.valuePx}px` }}
        title={props.valueTitle ?? (props.valueIsText ? props.value : undefined)}
      >
        {props.value}
      </div>
      {props.sub && <div class="font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 mt-2 max-w-full truncate">{props.sub}</div>}
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

function Leaders(props: { side: 'left' | 'right'; cx: number; cy: number; R: number; w: number; labels: [string, string] }) {
  const { cx, cy, R, w, side } = props;
  const dir = side === 'left' ? -1 : 1;
  const edge = side === 'left' ? 6 : w - 6;
  const rows = [
    { a: side === 'left' ? 208 : 332, dy: -0.58, label: props.labels[0] },
    { a: side === 'left' ? 152 : 28, dy: 0.58, label: props.labels[1] },
  ];
  return (
    <g>
      {rows.map((r, i) => {
        const [x0, y0] = pt(cx, cy, R + 4, r.a);
        const ey = cy + r.dy * R;
        const ex = cx + dir * (R + Math.min(36, R * 0.22));
        const elbowX = Math.abs(ex - cx) < Math.abs(x0 - cx) ? x0 + dir * 10 : ex;
        const textX = side === 'left' ? edge + 2 : edge - 2;
        const run = Math.abs(edge - elbowX);
        const showText = run > r.label.length * 6.9 + 10;
        return (
          <g key={i}>
            <polyline points={`${x0},${y0} ${elbowX},${ey} ${edge},${ey}`} fill="none" stroke={C.line} stroke-width="1" />
            <rect x={x0 - 2} y={y0 - 2} width="4" height="4" fill={C.red} />
            <rect x={edge - 2} y={ey - 2} width="4" height="4" fill={C.line} />
            {showText && (
              <text
                x={textX}
                y={ey - 6}
                fill={C.fg3}
                font-family="var(--font-mono)"
                font-size="9.5"
                letter-spacing="0.12em"
                text-anchor={side === 'left' ? 'start' : 'end'}
              >
                {r.label.toUpperCase()}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}
