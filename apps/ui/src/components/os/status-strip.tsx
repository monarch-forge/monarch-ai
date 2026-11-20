/**
 * Live status strip: quiet clickable chips in the top bar (workers running, approvals waiting, brief ready).
 * Renders nothing when there is nothing to show.
 */
import type { MorningBrief, SessionSummary } from '@monarch/shared';
import { approvals, navigate, useResource } from '../../lib/store.ts';
import { Glyph } from '../ui.tsx';
import { focusApprovals } from '../approvals.tsx';

const chip = 'shrink-0 flex items-center gap-1.5 h-7 px-1.5 text-[11px] uppercase tracking-[0.14em] text-fg-2 hover:text-fg transition-colors';

export function StatusStrip() {
  const sessions = useResource<SessionSummary[]>('/sessions', ['sessions'], { intervalMs: 30_000 });
  const brief = useResource<MorningBrief | null>('/brief', ['automations']);
  const workers = (sessions.data ?? []).filter((s) => s.running && (s.kind === 'coding' || !!s.parentSessionId)).length;
  const waiting = approvals.value.length;
  const b = brief.data;
  const briefToday = !!b && new Date(b.generatedAt).toDateString() === new Date().toDateString();
  if (!workers && !waiting && !briefToday) return null;
  return (
    <div class="hidden md:flex items-center gap-0.5 min-w-0" aria-label="Live status">
      {waiting > 0 && (
        <button type="button" class={`${chip} !text-red`} onClick={focusApprovals}>
          <Glyph value={Math.min(waiting, 3)} of={3} tone="red" live />
          {waiting} approval{waiting > 1 ? 's' : ''}
        </button>
      )}
      {workers > 0 && (
        <button type="button" class={chip} onClick={() => navigate('workshop')}>
          <Glyph value={Math.min(workers, 3)} of={3} live />
          {workers} agent{workers > 1 ? 's' : ''}
        </button>
      )}
      {briefToday && (
        <button type="button" class={chip} onClick={() => navigate('overview')}>
          <Glyph value={1} of={1} />
          brief ready
        </button>
      )}
    </div>
  );
}
