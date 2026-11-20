/**
 * Overview — the cozy home. One focus: a warm greeting and the command console.
 * Below it, at most three cards with what matters today (schedule, what is waiting on the user, inbox).
 * Telemetry (status card, weather, vitals, model usage, uplinks, assistant log) lives behind "More".
 */
import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { ChevronDown } from 'lucide-preact';
import type { Briefing, UsageReport } from '@monarch/shared';
import { approvals, conn, phase, settings, useResource } from '../lib/store.ts';
import { DotText, fmt, Panel, Sparkline, Stat, Tag, useNow } from '../components/ui.tsx';
import { focusApprovals } from '../components/approvals.tsx';
import { RefreshHint } from '../components/mail/kit.tsx';
import { CommandConsole } from '../components/overview/console.tsx';
import { EnvPanel, SchedulePanel, VitalsPanel } from '../components/overview/left-panels.tsx';
import { LogPanel, UplinksPanel, UsagePanel } from '../components/overview/right-panels.tsx';
import { InboxCard, WaitingCard } from '../components/overview/today-cards.tsx';
import { BriefCard } from '../components/overview/brief-card.tsx';

const MORE_KEY = 'monarch.overview.more';

export default function OverviewPage(_props: { params: string[] }) {
  const briefing = useResource<Briefing>('/briefing', ['tasks', 'events', 'mail', 'notifications', 'settings', 'google', 'slack'], { intervalMs: 5 * 60_000 });
  const usage = useResource<UsageReport>('/usage?range=24h', ['sessions'], { intervalMs: 60_000 });
  const [more, setMore] = useState(() => {
    try {
      // closed by default (calmer home); stays open only after the user opens it
      return localStorage.getItem(MORE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleMore = () => {
    const v = !more;
    setMore(v);
    try {
      localStorage.setItem(MORE_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  return (
    <div class="ov h-full overflow-y-auto overflow-x-hidden">
      <div class="mx-auto w-full max-w-[1080px] px-4 lg:px-6 pt-6 sm:pt-10 pb-24 flex flex-col gap-8">
        <section class="flex flex-col items-center gap-5" aria-label="Home">
          <Greeting briefing={briefing.data} error={briefing.error} hint={<RefreshHint res={briefing} />} />
          <div class="w-full max-w-[720px]">
            <CommandConsole />
          </div>
        </section>

        <BriefCard />

        <section class="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 items-start" aria-label="Today">
          <WaitingCard res={briefing} />
          <SchedulePanel class="max-h-[320px]" />
          <InboxCard res={briefing} />
        </section>

        <section aria-label="More">
          <button
            type="button"
            class="mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] text-fg-3 hover:text-fg hover:bg-surface transition-colors duration-150"
            onClick={toggleMore}
            aria-expanded={more}
          >
            {more ? 'Less' : 'More — status, weather, system and usage'}
            <ChevronDown size={14} strokeWidth={1.6} class={`transition-transform duration-150 ${more ? 'rotate-180' : ''}`} />
          </button>
          {more && (
            <div class="mt-4 grid gap-4 grid-cols-1 md:grid-cols-2 animate-monarch-fade">
              <StatusCard usage={usage.data} />
              <EnvPanel />
              <UsagePanel res={usage} />
              <VitalsPanel />
              <UplinksPanel class="min-h-[180px] max-h-[300px]" />
              <LogPanel class="md:col-span-2 min-h-[200px] max-h-[360px]" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function partOfDay(d = new Date()): string {
  const h = d.getHours();
  return h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}

function Greeting(props: { briefing?: Briefing; error?: string; hint?: ComponentChildren }) {
  const s = settings.value;
  const now = useNow(30_000);
  const honorific = s?.user.honorific?.trim() || 'sir';
  const greeting = props.briefing?.greeting ?? `Good ${partOfDay()}, ${honorific}.`;
  const headline =
    props.briefing?.headline ??
    (conn.value === 'open' ? (props.error ? 'Everything is running. Your briefing will be back shortly.' : 'Putting your day together…') : conn.value === 'connecting' ? 'Waking up…' : 'Monarch is offline for the moment.');
  return (
    <header class="relative text-center max-w-[640px]">
      <DotText class="block mb-3 text-[13px] text-fg-3 tracking-[0.2em]" title={now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}>
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </DotText>
      <h1 class="text-[clamp(24px,3vw,30px)] font-medium tracking-[-0.015em] text-fg leading-tight">{greeting}</h1>
      <p class="mt-2 text-[14px] text-fg-2 leading-relaxed">{headline}</p>
      {/* out of flow so the refresh marker never shifts the layout */}
      <div class="absolute left-0 right-0 -bottom-5 flex justify-center">{props.hint}</div>
    </header>
  );
}

/** agent state + today's token use (replaces the old status orb) */
function StatusCard(props: { usage?: UsageReport }) {
  const u = props.usage;
  const hourly = useMemo(() => {
    const buckets = new Array<number>(24).fill(0);
    const cutoff = Date.now() - 24 * 3600_000;
    for (const p of u?.points ?? []) {
      const t = Date.parse(p.ts);
      if (isNaN(t) || t < cutoff) continue;
      buckets[23 - Math.min(23, Math.floor((Date.now() - t) / 3600_000))] += (p.inputTokens ?? 0) + (p.outputTokens ?? 0);
    }
    return buckets;
  }, [u]);
  const total = u ? (u.totals?.inputTokens ?? 0) + (u.totals?.outputTokens ?? 0) : undefined;
  const pending = approvals.value.length;
  const state = conn.value !== 'open' ? 'Offline' : phase.value === 'idle' ? 'Ready' : phase.value === 'awaiting-approval' ? 'Waiting for you' : 'Working';
  return (
    <Panel title="Status" class="md:col-span-2" right={<Tag tone={state === 'Ready' ? 'ok' : state === 'Offline' ? 'red' : 'warn'}>{state}</Tag>}>
      <div class="grid grid-cols-[auto_1fr] sm:grid-cols-[auto_auto_1fr] gap-x-8 gap-y-3 items-end">
        <Stat label="Tokens · 24h" value={<DotText>{total !== undefined ? fmt.num(total) : '—'}</DotText>} />
        {pending > 0 ? (
          <button type="button" class="text-left" onClick={() => focusApprovals()}>
            <Stat label="Approvals" value={<span class="text-warning">{pending} pending</span>} />
          </button>
        ) : (
          <Stat label="Approvals" value="None" />
        )}
        <div class="col-span-2 sm:col-span-1 min-w-0">
          <Sparkline values={hourly} height={36} min={0} />
          <div class="flex justify-between text-[10.5px] text-fg-3 mt-0.5">
            <span>24h ago</span>
            <span>now</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
