/**
 * Overview — the hero HUD. Three columns around the agent core:
 *   left:   ENV.01 conditions · CAL.02 schedule · SYS.03 vitals
 *   centre: greeting · core orb · command console · FLG.07 flagged
 *   right:  USG.04 model usage · LNK.05 uplinks · COM.06 assistant log
 * Fits the viewport without scrolling at ≥1280×760; stacks and scrolls below that.
 * OWNED BY UI-A.
 */
import { useMemo } from 'preact/hooks';
import type { Briefing, UsageReport } from '@monarch/shared';
import { conn, health, settings, useResource } from '../lib/store.ts';
import { fmt } from '../components/ui.tsx';
import { CoreOrb } from '../components/core-orb.tsx';
import { CommandConsole } from '../components/overview/console.tsx';
import { EnvPanel, SchedulePanel, VitalsPanel } from '../components/overview/left-panels.tsx';
import { LogPanel, UplinksPanel, UsagePanel } from '../components/overview/right-panels.tsx';
import { FlagsPanel } from '../components/overview/flags-panel.tsx';

export default function OverviewPage(_props: { params: string[] }) {
  const briefing = useResource<Briefing>('/briefing', ['tasks', 'events', 'mail', 'notifications', 'settings', 'google', 'slack'], { intervalMs: 5 * 60_000 });
  const usage = useResource<UsageReport>('/usage?range=24h', ['sessions'], { intervalMs: 60_000 });

  return (
    <div class="h-full overflow-y-auto overflow-x-hidden">
      <div
        class="grid gap-3 p-3 xl:p-4 grid-cols-1 lg:grid-cols-2 xl:h-full xl:min-h-[640px] xl:grid-cols-[minmax(300px,1fr)_minmax(440px,1.42fr)_minmax(300px,1fr)] xl:grid-rows-[minmax(0,1fr)]"
      >
        {/* centre first in DOM order for small screens / reading order */}
        <section class="flex flex-col min-h-0 min-w-0 gap-3 lg:col-span-2 xl:col-span-1 xl:col-start-2 xl:row-start-1" aria-label="Core">
          <Greeting briefing={briefing.data} error={briefing.error} />
          <div class="flex-1 min-h-[300px] xl:min-h-0 relative">
            <OrbBlock usage={usage.data} />
          </div>
          <div class="shrink-0">
            <CommandConsole />
          </div>
          <FlagsPanel res={briefing} class="shrink-0 h-[148px] xl:h-[clamp(132px,19vh,180px)]" />
        </section>

        <section class="flex flex-col min-h-0 min-w-0 gap-3 xl:col-start-1 xl:row-start-1" aria-label="Environment and schedule">
          <EnvPanel class="shrink-0" />
          <SchedulePanel class="flex-1 min-h-[220px] xl:min-h-[150px]" />
          <VitalsPanel class="shrink-0" />
        </section>

        <section class="flex flex-col min-h-0 min-w-0 gap-3 xl:col-start-3 xl:row-start-1" aria-label="Usage, uplinks and log">
          <UsagePanel res={usage} class="shrink-0" />
          <UplinksPanel class="flex-[0.85] min-h-[150px] xl:min-h-[118px]" />
          <LogPanel class="flex-1 min-h-[200px] xl:min-h-[140px]" />
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
    props.briefing?.headline ?? (conn.value === 'open' ? (props.error ? 'Briefing unavailable. Core systems online.' : 'Compiling your briefing…') : conn.value === 'connecting' ? 'Establishing link to core…' : 'Core offline. Local telemetry unavailable.');
  return (
    <header class="shrink-0 text-center pt-1">
      <h1 class="text-[clamp(24px,2.3vw,32px)] font-light tracking-[-0.01em] text-fg leading-tight">{greeting}</h1>
      <p class="mt-1.5 flex items-center justify-center gap-2 text-[13px] text-fg-2">
        <span class="inline-block w-[5px] h-[5px] bg-red shrink-0" aria-hidden="true" />
        <span class="truncate">{headline}</span>
      </p>
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
  const s = settings.value;
  const h = health.value;
  const model = s ? (s.engine === 'claude-sdk' ? s.claudeSdk.model : `${s.pi.provider}/${s.pi.model}`) : h?.model;
  const engine = s?.engine ?? h?.engine;
  const ringText = [
    'Monarch core',
    engine ? `engine ${engine}` : null,
    model ? `model ${model}` : null,
    h ? `proto v${h.protocol}` : null,
    u ? `${fmt.num(u.totals?.requests ?? 0)} req / 24h` : null,
  ]
    .filter(Boolean)
    .join('  //  ');

  return (
    <div class="absolute inset-0">
      <CoreOrb
        hourly={hourly}
        idleValue={total !== undefined ? fmt.num(total) : '—'}
        idleSub={total !== undefined ? `tokens · 24h · ${fmt.usd(u?.totals?.costUsd ?? 0)}` : 'ready'}
        ringText={ringText}
        leftLabels={['ENV.01', 'SYS.03']}
        rightLabels={['USG.04', 'LNK.05']}
      />
    </div>
  );
}
