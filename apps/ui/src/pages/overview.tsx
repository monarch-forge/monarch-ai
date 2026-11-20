/**
 * Overview — Glyph command home. Left: presence line, dot-matrix greeting, headline, command console,
 * the morning brief and the open threads of the latest chat. Right: Needs you, Agents, Next, Inbox.
 * Telemetry (status card, weather, vitals, model usage, uplinks, assistant log) lives behind "More".
 */
import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { ChevronDown } from 'lucide-preact';
import type { Briefing, ChatThread, SessionSummary, UsageReport } from '@monarch/shared';
import { approvals, conn, phase, useResource } from '../lib/store.ts';
import { DotText, fmt, Panel, Sparkline, Stat, Tag, useNow } from '../components/ui.tsx';
import { focusApprovals } from '../components/approvals.tsx';
import { RefreshHint } from '../components/mail/kit.tsx';
import { CommandConsole } from '../components/overview/console.tsx';
import { EnvPanel, VitalsPanel } from '../components/overview/left-panels.tsx';
import { LogPanel, UplinksPanel, UsagePanel } from '../components/overview/right-panels.tsx';
import { AgentsCard, InboxCard, NeedsYouCard, NextCard } from '../components/overview/today-cards.tsx';
import { BriefCard } from '../components/overview/brief-card.tsx';

const MORE_KEY = 'monarch.overview.more';

export default function OverviewPage(_props: { params: string[] }) {
  const briefing = useResource<Briefing>('/briefing', ['tasks', 'events', 'mail', 'notifications', 'settings', 'google', 'slack'], { intervalMs: 5 * 60_000 });
  const usage = useResource<UsageReport>('/usage?range=24h', ['sessions'], { intervalMs: 60_000 });
  const sessions = useResource<SessionSummary[]>('/sessions', ['sessions'], { intervalMs: 30_000 });
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
  const agents = (sessions.data ?? []).filter((s) => s.running && (s.kind === 'coding' || s.parentSessionId)).length;

  return (
    <div class="ov h-full overflow-y-auto overflow-x-hidden">
      <div class="mx-auto w-full max-w-[1440px] px-4 sm:px-10 pt-6 sm:pt-10 pb-24 flex flex-col gap-10">
        <div class="grid grid-cols-1 min-[1100px]:grid-cols-12 gap-8">
          <section class="min-[1100px]:col-span-7 flex flex-col gap-[26px] min-w-0" aria-label="Home">
            <Greeting briefing={briefing.data} error={briefing.error} agents={agents} hint={<RefreshHint res={briefing} />} />
            <CommandConsole />
            <BriefCard />
            <Threads />
          </section>
          <section class="min-[1100px]:col-span-5 flex flex-col gap-4 min-w-0" aria-label="Today">
            <NeedsYouCard res={briefing} />
            <AgentsCard res={sessions} />
            <div class="grid grid-cols-2 gap-4">
              <NextCard res={briefing} />
              <InboxCard res={briefing} />
            </div>
          </section>
        </div>

        <section aria-label="More" class="ds-rule pt-4">
          <button
            type="button"
            class="mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full ds-label hover:text-fg transition-colors duration-150"
            onClick={toggleMore}
            aria-expanded={more}
          >
            {more ? 'Less' : 'More · status, weather, system, usage'}
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

/** 5x3 presence matrix; centre dot is red and blinks while the agent works */
function Presence(props: { live: boolean }) {
  const lvl = [0, 1, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 1, 0];
  const cls = ['bg-line', 'bg-fg-3', 'bg-fg', props.live ? 'bg-red hud-blink' : 'bg-fg'];
  return (
    <span class="grid grid-cols-[repeat(5,7px)] gap-[5px] shrink-0" aria-hidden="true">
      {lvl.map((l, i) => (
        <i key={i} class={`w-[7px] h-[7px] rounded-full ${cls[l]}`} />
      ))}
    </span>
  );
}

function Greeting(props: { briefing?: Briefing; error?: string; agents: number; hint?: ComponentChildren }) {
  const now = useNow(30_000);
  const pod = /good (morning|afternoon|evening|night)/i.exec(props.briefing?.greeting ?? '')?.[1] ?? partOfDay(now);
  const headline =
    props.briefing?.headline ??
    (conn.value === 'open' ? (props.error ? 'Everything is running. Your briefing will be back shortly.' : 'Putting your day together…') : conn.value === 'connecting' ? 'Waking up…' : 'Monarch is offline for the moment.');
  const state = conn.value !== 'open' ? 'Offline' : phase.value === 'idle' ? (props.agents ? 'Working' : 'Ready') : phase.value === 'awaiting-approval' ? 'Waiting' : 'Working';
  const date = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
  const status = [state, props.agents ? `${props.agents} agent${props.agents === 1 ? '' : 's'}` : '', date].filter(Boolean).join(' · ');
  return (
    <header class="relative flex flex-col gap-[26px]">
      <div class="flex items-center gap-4">
        <Presence live={state === 'Working' || state === 'Waiting'} />
        <span class="text-[11px] tracking-[0.16em] uppercase text-[#9e9ea4] truncate">{status}</span>
      </div>
      <h1 class="m-0">
        <DotText class="block text-[48px] sm:text-[clamp(56px,6vw,84px)] leading-[0.95] tracking-[0.02em] text-fg uppercase">
          Good
          <br />
          {pod}
        </DotText>
      </h1>
      <p class="m-0 text-[18px] text-fg-2 max-w-[540px] leading-snug">{headline}</p>
      {/* out of flow so the refresh marker never shifts the layout */}
      <div class="absolute left-0 -bottom-5">{props.hint}</div>
    </header>
  );
}

/** open threads of the most recent chat session */
function Threads() {
  const chats = useResource<SessionSummary[]>('/sessions?kind=chat', ['sessions']);
  const latest = useMemo(() => [...(chats.data ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0], [chats.data]);
  const threads = useResource<ChatThread[]>(latest ? `/sessions/${latest.id}/threads` : null, ['sessions']);
  const open = (threads.data ?? []).filter((t) => t.status !== 'done');
  if (!latest || open.length === 0) return null;
  return (
    <section class="mt-auto ds-rule pt-[18px] flex flex-col gap-3" aria-label="Threads">
      <span class="ds-label">Threads</span>
      {open.slice(0, 5).map((t) => (
        <a key={t.id} href={`#/chat/${latest.id}`} class="flex items-center gap-3.5 text-[14px] min-w-0 group">
          <span class={`w-[70px] shrink-0 text-[11px] uppercase tracking-[0.12em] ${t.status === 'waiting' ? 'text-warning' : 'text-fg-2'}`}>{t.status === 'waiting' ? 'Waiting' : 'Open'}</span>
          <span class="flex-1 min-w-0 truncate text-fg group-hover:underline">{t.title}</span>
          <span class="hidden sm:block max-w-[45%] truncate text-[12px] text-fg-3">{[t.area, t.next].filter(Boolean).join(' · ')}</span>
        </a>
      ))}
    </section>
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
