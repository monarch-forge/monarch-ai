/** Session metadata blocks shared by Comms / Workshop. */
import type { EngineId, SessionDetail, SessionSummary, Settings } from '@monarch/shared';
import { fmt, Stat } from '../ui.tsx';
import { totalTokens, type TurnInfo } from '../../lib/chat-store.ts';
import { fmtDuration } from './tool-card.tsx';
import { api } from '../../lib/api.ts';
import { toast } from '../../lib/store.ts';

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

function kTok(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** "CTX 42% · 84k / 200k" with a thin bar: fg → warning ≥60% → red ≥ the auto-compact threshold (75%) */
export function ContextMeter(props: { context: SessionSummary['context']; autoCompactPercent?: number; compact?: boolean }) {
  const c = props.context;
  if (!c || !c.used) return null;
  const pct = c.window ? Math.min(100, c.percent) : 0;
  const auto = props.autoCompactPercent ?? 75;
  const hot = auto > 0 ? auto : 75;
  const tone = pct >= hot ? 'bg-red' : pct >= 60 ? 'bg-warning' : 'bg-fg-2';
  const text = pct >= hot ? 'text-red' : pct >= 60 ? 'text-warning' : '';
  const tip = [
    `Context: ${c.used.toLocaleString()} of ${c.window ? c.window.toLocaleString() : '?'} tokens${c.window ? ` (${c.percent}%)` : ''}`,
    auto > 0 ? `Auto-compacts at ${auto}%` : 'Auto-compaction off',
    `Compactions: ${c.compactions}${c.lastCompactedAt ? ` · last ${new Date(c.lastCompactedAt).toLocaleString()}` : ''}`,
    'Type /compact to compact now',
  ].join('\n');
  if (props.compact) {
    return (
      <span class={`tabular-nums ${text}`} title={tip}>
        {c.window ? `${Math.round(pct)}%` : kTok(c.used)}
      </span>
    );
  }
  return (
    <span class={`flex items-center gap-1.5 shrink-0 ${text}`} title={tip} data-testid="context-meter">
      <span>CTX {c.window ? `${Math.round(pct)}%` : ''}</span>
      <span class="relative inline-block w-14 h-[3px] bg-line overflow-hidden">
        <span class={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${Math.max(2, pct)}%` }} />
        {auto > 0 && <span class="absolute inset-y-0 w-px bg-fg-3" style={{ left: `${auto}%` }} />}
      </span>
      <span class="hidden lg:inline tabular-nums normal-case">
        {kTok(c.used)}
        {c.window ? ` / ${kTok(c.window)}` : ''}
      </span>
    </span>
  );
}

/** /compact: compact the open session's context now (core runs it as a turn and posts a transcript note) */
export function compactCommand(sessionId: string | undefined | null, running: boolean): void {
  if (!sessionId) return void toast('Nothing to compact yet', 'warn');
  if (running) return void toast('Wait for the current turn to finish, then /compact', 'warn');
  api.post(`/sessions/${encodeURIComponent(sessionId)}/compact`).catch((e) => toast(String(e?.message ?? e), 'error'));
}
