/**
 * Overview — the cozy home. One focus: a warm greeting, a small calm orb and the command console.
 * Below it, at most three cards with what matters today (schedule, what is waiting on the user, inbox).
 * Telemetry (weather, vitals, model usage, uplinks, assistant log) lives behind "More".
 */
import { useMemo, useState } from 'preact/hooks';
import { ChevronDown } from 'lucide-preact';
import type { Briefing, UsageReport } from '@monarch/shared';
import { conn, settings, useResource } from '../lib/store.ts';
import { fmt } from '../components/ui.tsx';
import { CoreOrb } from '../components/core-orb.tsx';
import { CommandConsole } from '../components/overview/console.tsx';
import { EnvPanel, SchedulePanel, VitalsPanel } from '../components/overview/left-panels.tsx';
import { LogPanel, UplinksPanel, UsagePanel } from '../components/overview/right-panels.tsx';
import { InboxCard, WaitingCard } from '../components/overview/today-cards.tsx';

const MORE_KEY = 'monarch.overview.more';

export default function OverviewPage(_props: { params: string[] }) {
  const briefing = useResource<Briefing>('/briefing', ['tasks', 'events', 'mail', 'notifications', 'settings', 'google', 'slack'], { intervalMs: 5 * 60_000 });
  const usage = useResource<UsageReport>('/usage?range=24h', ['sessions'], { intervalMs: 60_000 });
  const [more, setMore] = useState(() => {
    try {
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
          <div class="relative w-[148px] h-[148px] sm:w-[176px] sm:h-[176px]">
            <OrbBlock usage={usage.data} />
          </div>
          <Greeting briefing={briefing.data} error={briefing.error} />
          <div class="w-full max-w-[720px]">
            <CommandConsole />
          </div>
        </section>

        <section class="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 items-start" aria-label="Today">
          <SchedulePanel class="max-h-[320px] md:col-span-2 lg:col-span-1" />
          <WaitingCard res={briefing} />
          <InboxCard res={briefing} />
        </section>

        <section aria-label="More">
          <button
            type="button"
            class="mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] text-fg-3 hover:text-fg hover:bg-surface transition-colors duration-150"
            onClick={toggleMore}
            aria-expanded={more}
          >
            {more ? 'Less' : 'More — weather, system and usage'}
            <ChevronDown size={14} strokeWidth={1.6} class={`transition-transform duration-150 ${more ? 'rotate-180' : ''}`} />
          </button>
          {more && (
            <div class="mt-4 grid gap-4 grid-cols-1 md:grid-cols-2 animate-monarch-fade">
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

function Greeting(props: { briefing?: Briefing; error?: string }) {
  const s = settings.value;
  const honorific = s?.user.honorific?.trim() || 'sir';
  const greeting = props.briefing?.greeting ?? `Good ${partOfDay()}, ${honorific}.`;
  const headline =
    props.briefing?.headline ??
    (conn.value === 'open' ? (props.error ? 'Everything is running. Your briefing will be back shortly.' : 'Putting your day together…') : conn.value === 'connecting' ? 'Waking up…' : 'Monarch is offline for the moment.');
  return (
    <header class="text-center max-w-[640px]">
      <h1 class="text-[clamp(24px,3vw,30px)] font-medium tracking-[-0.015em] text-fg leading-tight">{greeting}</h1>
      <p class="mt-2 text-[14px] text-fg-2 leading-relaxed">{headline}</p>
    </header>
  );
}

function OrbBlock(props: { usage?: UsageReport }) {
  const u = props.usage;
  const hourly = useMemo(() => {
    if (!u?.points?.length) return undefined;
    const buckets = new Array<number>(24).fill(0);
    const cutoff = Date.now() - 24 * 3600_000;
    for (const p of u.points) {
      const t = Date.parse(p.ts);
      if (isNaN(t) || t < cutoff - 3600_000) continue;
      buckets[new Date(t).getHours()] += (p.inputTokens ?? 0) + (p.outputTokens ?? 0);
    }
    const max = Math.max(...buckets);
    return max > 0 ? buckets.map((b) => b / max) : buckets;
  }, [u]);

  const total = u ? (u.totals?.inputTokens ?? 0) + (u.totals?.outputTokens ?? 0) : undefined;
  return (
    <div class="absolute inset-0">
      <CoreOrb hourly={hourly} idleValue={total !== undefined ? fmt.num(total) : '—'} idleSub={total !== undefined ? 'tokens today' : 'ready'} />
    </div>
  );
}
