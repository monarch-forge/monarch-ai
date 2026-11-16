/** Session metadata blocks shared by Comms / Workshop. */
import type { EngineId, SessionDetail, SessionSummary, Settings } from '@monarch/shared';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { fmt } from '../ui.tsx';
import { totalTokens, type TurnInfo } from '../../lib/chat-store.ts';
import { fmtDuration } from './tool-card.tsx';
import { api } from '../../lib/api.ts';
import { settings, toast } from '../../lib/store.ts';

export function engineName(e: EngineId | undefined): string {
  return e === 'pi' ? 'Pi' : 'Claude';
}

/** "Claude · opus" for a session, or the configured default */
export function engineLabel(s: Settings | null, engine?: EngineId, model?: string): string {
  const e = engine ?? s?.engine;
  if (!e) return '—';
  const m = model || (e === 'pi' ? (s ? `${s.pi.provider}/${s.pi.model}` : '') : (s?.claudeSdk.model ?? ''));
  return `${engineName(e)}${m ? ` · ${m}` : ''}`;
}

function Row(props: { label: string; children: ComponentChildren; wide?: boolean }) {
  return (
    <div class={`flex gap-3 py-1.5 ${props.wide ? 'flex-col gap-0.5' : 'items-baseline'}`}>
      <dt class="text-[12px] text-fg-3 shrink-0 w-24">{props.label}</dt>
      <dd class="text-[12.5px] text-fg-2 min-w-0 break-words tabular-nums">{props.children}</dd>
    </div>
  );
}

/** quiet details list: the essentials first, the rest behind "More" */
export function SessionStats(props: { session: SessionDetail; lastTurn?: TurnInfo | null }) {
  const { session: s, lastTurn } = props;
  const [more, setMore] = useState(false);
  const u = s.usage ?? { inputTokens: 0, outputTokens: 0 };
  return (
    <div>
      <dl>
        <Row label="Model">
          {engineName(s.engine)} · {s.model || '—'}
        </Row>
        {s.context?.used ? (
          <Row label="Context">
            <ContextMeter context={s.context} autoCompactPercent={settings.value?.agent?.autoCompactPercent} />
          </Row>
        ) : null}
        <Row label="Tokens">{fmt.num(totalTokens(u))}</Row>
        {u.costUsd !== undefined && <Row label="Cost">{fmt.usd(u.costUsd)}</Row>}
        {lastTurn?.durationMs !== undefined && <Row label="Last reply">{fmtDuration(lastTurn.durationMs)}</Row>}
        <Row label="Started">{s.createdAt ? fmt.dateTime(s.createdAt) : '—'}</Row>
      </dl>
      <button class="mt-2 text-[12px] text-fg-3 hover:text-fg-2" onClick={() => setMore(!more)} aria-expanded={more}>
        {more ? 'Less' : 'More details'}
      </button>
      {more && (
        <dl class="mt-1">
          <Row label="Kind">{s.kind}</Row>
          <Row label="Tokens in">{fmt.num(u.inputTokens ?? 0)}</Row>
          <Row label="Tokens out">{fmt.num(u.outputTokens ?? 0)}</Row>
          {u.cacheReadTokens || u.cacheWriteTokens ? (
            <>
              <Row label="Cache read">{fmt.num(u.cacheReadTokens ?? 0)}</Row>
              <Row label="Cache write">{fmt.num(u.cacheWriteTokens ?? 0)}</Row>
            </>
          ) : null}
          {lastTurn?.usage?.costUsd !== undefined && <Row label="Reply cost">{fmt.usd(lastTurn.usage.costUsd)}</Row>}
          <Row label="Messages">{s.itemCount || s.items.length}</Row>
          <Row label="Updated">{s.updatedAt ? fmt.dateTime(s.updatedAt) : '—'}</Row>
          {s.context?.compactions ? <Row label="Compactions">{s.context.compactions}</Row> : null}
          {s.cwd && (
            <Row label="Directory" wide>
              <span class="font-mono text-[11px]">{s.cwd}</span>
            </Row>
          )}
          <Row label="Id" wide>
            <span class="font-mono text-[11px] text-fg-3">{s.id}</span>
          </Row>
        </dl>
      )}
    </div>
  );
}

function kTok(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** "▬ 42% of 200k" with a thin rounded bar: fg → warning ≥60% → red ≥ the auto-compact threshold (75%) */
export function ContextMeter(props: { context: SessionSummary['context']; autoCompactPercent?: number; compact?: boolean }) {
  const c = props.context;
  if (!c || !c.used) return null;
  const pct = c.window ? Math.min(100, c.percent) : 0;
  const auto = props.autoCompactPercent ?? 75;
  const hot = auto > 0 ? auto : 75;
  const tone = pct >= hot ? 'bg-red' : pct >= 60 ? 'bg-warning' : 'bg-fg-3';
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
    <span class={`inline-flex items-center gap-1.5 shrink-0 text-[11.5px] text-fg-3 ${text}`} title={tip} data-testid="context-meter">
      <span class="relative inline-block w-10 h-[4px] rounded-full bg-[var(--bg-subtle)] overflow-hidden">
        <span class={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${Math.max(4, pct)}%` }} />
      </span>
      <span class="tabular-nums">{c.window ? `${Math.round(pct)}%` : kTok(c.used)}</span>
      <span class="hidden lg:inline tabular-nums">{c.window ? `of ${kTok(c.window)}` : 'tokens'}</span>
    </span>
  );
}

/** /compact: compact the open session's context now (core runs it as a turn and posts a transcript note) */
export function compactCommand(sessionId: string | undefined | null, running: boolean): void {
  if (!sessionId) return void toast('Nothing to compact yet', 'warn');
  if (running) return void toast('Wait for the current turn to finish, then /compact', 'warn');
  api.post(`/sessions/${encodeURIComponent(sessionId)}/compact`).catch((e) => toast(String(e?.message ?? e), 'error'));
}
