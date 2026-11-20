/**
 * Ambient presence: a 3×3 dot-matrix in the top bar showing what Monarch is doing.
 * Click: pending approvals -> focus them, otherwise open the Ask bar.
 */
import { approvals, conn, phase, phaseDetail } from '../../lib/store.ts';
import { listening } from '../../lib/voice.ts';
import { focusApprovals } from '../approvals.tsx';
import { askOpen } from './ask-bar.tsx';

type State = 'offline' | 'idle' | 'listening' | 'thinking' | 'working' | 'waiting';

const LABEL: Record<State, string> = {
  offline: 'Offline — core unreachable',
  idle: 'Idle — press Ctrl+Space to ask',
  listening: 'Listening…',
  thinking: 'Thinking…',
  working: 'Working — running tools',
  waiting: 'Waiting for you — approval pending',
};

const CSS = `
.os-presence{display:grid;grid-template-columns:repeat(3,4px);gap:2px;padding:4px;border-radius:7px}
.os-presence>i{width:4px;height:4px;border-radius:999px;background:#f4f4f6;opacity:.18;transition:opacity .4s}
.os-presence[data-s=idle]>i:nth-child(5){animation:osBreathe 3.2s ease-in-out infinite}
.os-presence[data-s=offline]>i{opacity:.12}
.os-presence[data-s=listening]>i:nth-child(3n+2){animation:osBar .9s ease-in-out infinite}
.os-presence[data-s=listening]>i:nth-child(5){animation-delay:.15s}
.os-presence[data-s=listening]>i:nth-child(8){animation-delay:.3s}
.os-presence[data-s=thinking]>i{animation:osFlow 1.4s ease-in-out infinite;animation-delay:calc(var(--i)*.09s)}
.os-presence[data-s=working]>i{animation:osFlow .8s steps(2) infinite;animation-delay:calc(var(--j)*.13s)}
.os-presence[data-s=waiting]>i{background:#d71921;animation:osBreathe 1.1s ease-in-out infinite}
@keyframes osBreathe{0%,100%{opacity:.25}50%{opacity:.9}}
@keyframes osBar{0%,100%{opacity:.2}50%{opacity:1}}
@keyframes osFlow{0%,100%{opacity:.15}40%{opacity:.95}}
@media (prefers-reduced-motion:reduce){.os-presence>i{animation:none!important}
.os-presence[data-s=thinking]>i,.os-presence[data-s=working]>i,.os-presence[data-s=listening]>i{opacity:.6}
.os-presence[data-s=waiting]>i,.os-presence[data-s=idle]>i:nth-child(5){opacity:.85}}
`;

export function presenceState(): State {
  if (conn.value !== 'open') return 'offline';
  if (approvals.value.length || phase.value === 'awaiting-approval') return 'waiting';
  if (listening.value) return 'listening';
  if (phase.value === 'tool') return 'working';
  if (phase.value === 'thinking' || phase.value === 'responding') return 'thinking';
  return 'idle';
}

export function Presence() {
  const s = presenceState();
  const label = s === 'working' && phaseDetail.value ? `Working — ${phaseDetail.value}` : LABEL[s];
  return (
    <button
      type="button"
      class="shrink-0 rounded-[9px] hover:bg-raised transition-colors"
      title={label}
      aria-label={`Monarch: ${label}`}
      onClick={() => (s === 'waiting' && approvals.value.length ? focusApprovals() : (askOpen.value = true))}
    >
      <style>{CSS}</style>
      <span class="os-presence" data-s={s} aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => (
          // --i: diagonal order for the flow; --j: column order for the working scan
          <i key={i} style={{ '--i': (i % 3) + Math.floor(i / 3), '--j': i % 3 }} />
        ))}
      </span>
    </button>
  );
}
