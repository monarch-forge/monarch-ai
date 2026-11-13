/** Session metadata blocks shared by Comms / Workshop. */
import type { EngineId, SessionDetail, Settings } from '@monarch/shared';
import { fmt, Stat } from '../ui.tsx';
import { totalTokens, type TurnInfo } from '../../lib/chat-store.ts';
import { fmtDuration } from './tool-card.tsx';

export function engineName(e: EngineId | undefined): string {
  return e === 'pi' ? 'PI' : 'CLAUDE SDK';
}

/** "CLAUDE SDK · opus" for a session, or the configured default */
export function engineLabel(s: Settings | null, engine?: EngineId, model?: string): string {
  const e = engine ?? s?.engine;
  if (!e) return '—';
  const m = model || (e === 'pi' ? (s ? `${s.pi.provider}/${s.pi.model}` : '') : (s?.claudeSdk.model ?? ''));
  return `${engineName(e)}${m ? ` · ${m}` : ''}`;
}

export function SessionStats(props: { session: SessionDetail; lastTurn?: TurnInfo | null }) {
  const { session: s, lastTurn } = props;
  const u = s.usage ?? { inputTokens: 0, outputTokens: 0 };
  return (
    <div class="grid grid-cols-2 gap-x-4 gap-y-3">
      <Stat label="Engine" value={<span class="text-[12px]">{engineName(s.engine)}</span>} />
      <Stat label="Kind" value={<span class="text-[12px] uppercase">{s.kind}</span>} />
      <Stat class="col-span-2" label="Model" value={<span class="text-[12px] break-all">{s.model || '—'}</span>} />
      <Stat label="Tokens in" value={fmt.num(u.inputTokens ?? 0)} />
      <Stat label="Tokens out" value={fmt.num(u.outputTokens ?? 0)} />
      {(u.cacheReadTokens || u.cacheWriteTokens) ? (
        <>
          <Stat label="Cache read" value={fmt.num(u.cacheReadTokens ?? 0)} />
          <Stat label="Cache write" value={fmt.num(u.cacheWriteTokens ?? 0)} />
        </>
      ) : null}
      <Stat label="Total" value={fmt.num(totalTokens(u))} />
      <Stat label="Cost" value={u.costUsd !== undefined ? fmt.usd(u.costUsd) : '—'} />
      <Stat label="Items" value={s.itemCount || s.items.length} />
      <Stat label="Status" value={<span class={`text-[12px] ${s.running ? 'text-red' : 'text-fg-2'}`}>{s.running ? 'RUNNING' : 'IDLE'}</span>} />
      {lastTurn?.durationMs !== undefined && <Stat label="Last turn" value={fmtDuration(lastTurn.durationMs)} />}
      {lastTurn?.usage?.costUsd !== undefined && <Stat label="Turn cost" value={fmt.usd(lastTurn.usage.costUsd)} />}
      <Stat class="col-span-2" label="Created" value={<span class="text-[12px]">{s.createdAt ? fmt.dateTime(s.createdAt) : '—'}</span>} />
      <Stat class="col-span-2" label="Updated" value={<span class="text-[12px]">{s.updatedAt ? fmt.dateTime(s.updatedAt) : '—'}</span>} />
      {s.cwd && <Stat class="col-span-2" label="Directory" value={<span class="text-[11px] break-all">{s.cwd}</span>} />}
    </div>
  );
}
