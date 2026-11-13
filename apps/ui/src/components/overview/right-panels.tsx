/** Overview right column: USG.04 model usage, LNK.05 uplinks, COM.06 assistant log. OWNED BY UI-A. */
import { useMemo } from 'preact/hooks';
import type { GoogleAccount, ProviderStatus, SlackWorkspace, UsageReport } from '@monarch/shared';
import { activityLog, conn, health, navigate, phase, settings, useResource, type Resource } from '../../lib/store.ts';
import { Panel, SegBar, Sparkline, Tag, fmt } from '../ui.tsx';
import { Gate, Offline, PanelNote } from './common.tsx';

/* ───────────────────────── USG.04 ───────────────────────── */

export function engineLabel(): string {
  const s = settings.value;
  if (s) return s.engine === 'claude-sdk' ? `Claude · ${s.claudeSdk.model}` : `Pi · ${s.pi.model}`;
  return health.value?.model ?? '';
}

export function UsagePanel(props: { res: Resource<UsageReport>; class?: string }) {
  const label = engineLabel();
  return (
    <Panel code="USG.04" title="Model usage" class={props.class} right={label ? <Tag tone="plain" title="Active engine / model">{label}</Tag> : undefined}>
      <Gate res={props.res}>{(u) => <UsageBody u={u} />}</Gate>
    </Panel>
  );
}

function UsageBody(props: { u: UsageReport }) {
  const { u } = props;
  const totals = u.totals ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, requests: 0 };
  const total = (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0);
  const series = (u.points ?? []).map((p) => (p.inputTokens ?? 0) + (p.outputTokens ?? 0));
  const byModel = (u.byModel ?? []).slice().sort((a, b) => b.tokens - a.tokens).slice(0, 3);
  const maxTok = Math.max(1, ...byModel.map((m) => m.tokens));
  return (
    <div class="flex flex-col gap-2.5">
      <div class="flex items-end justify-between gap-3">
        <div>
          <div class="font-mono font-light text-[32px] leading-none tracking-tight tabular-nums text-fg">{fmt.num(total)}</div>
          <div class="hud-label text-[10px] mt-1.5">Tokens · 24h</div>
        </div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-0.5 text-right">
          <span class="hud-label text-[10px]">Cost</span>
          <span class="hud-label text-[10px]">Req</span>
          <span class="hud-value text-[13px]">{fmt.usd(totals.costUsd ?? 0)}</span>
          <span class="hud-value text-[13px]">{fmt.num(totals.requests ?? 0)}</span>
        </div>
      </div>
      <div class="relative">
        <Sparkline values={series.length > 1 ? series : [0, 0]} height={34} min={0} stroke="#D71921" fill="rgb(215 25 33 / 0.08)" />
        <div class="flex justify-between font-mono text-[9px] text-fg-3 tracking-[0.1em] mt-0.5">
          <span>−24H</span>
          <span>
            IN {fmt.num(totals.inputTokens ?? 0)} · OUT {fmt.num(totals.outputTokens ?? 0)}
          </span>
          <span>NOW</span>
        </div>
      </div>
      {byModel.length > 0 ? (
        <div class="flex flex-col gap-1 border-t border-line pt-2">
          {byModel.map((m) => (
            <div key={m.model} class="grid grid-cols-[1fr_64px_52px_48px] items-center gap-2 text-[11px]">
              <span class="font-mono text-fg-2 truncate" title={m.model}>
                {m.model}
              </span>
              <SegBar value={(m.tokens / maxTok) * 100} segments={8} />
              <span class="hud-value text-right">{fmt.num(m.tokens)}</span>
              <span class="hud-value text-right text-fg-2">{fmt.usd(m.costUsd ?? 0)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div class="border-t border-line pt-2 font-mono text-[10px] tracking-[0.14em] uppercase text-fg-3">No model calls in 24h</div>
      )}
    </div>
  );
}

/* ───────────────────────── LNK.05 ───────────────────────── */

interface Link {
  key: string;
  code: string;
  name: string;
  kind: string;
  strength: number; // 0..100
  tone: 'default' | 'red' | 'fg';
  status: string;
  statusTone: 'fg' | 'muted' | 'red';
  href: string;
  title?: string;
}

export function UplinksPanel(props: { class?: string }) {
  const prov = useResource<ProviderStatus[]>('/providers', ['providers', 'settings']);
  const goog = useResource<GoogleAccount[]>('/google/accounts', ['google']);
  const slack = useResource<SlackWorkspace[]>('/slack/workspaces', ['slack']);
  const s = settings.value;
  const activeProvider = s ? (s.engine === 'claude-sdk' ? 'claude-sdk' : s.pi.provider) : health.value?.engine;

  const links = useMemo<Link[]>(() => {
    const out: Omit<Link, 'code'>[] = [];
    for (const p of prov.data ?? []) {
      const active = p.id === activeProvider;
      if (!p.configured && !active && !p.error) continue;
      out.push({
        key: `p:${p.id}`,
        name: p.name || p.id,
        kind: active ? 'ENGINE' : 'MODEL',
        strength: p.error ? 100 : p.configured ? (p.latencyMs ? latencyStrength(p.latencyMs) : 100) : 0,
        tone: p.error ? 'red' : active ? 'fg' : 'default',
        status: p.error ? 'ERR' : !p.configured ? 'NO AUTH' : p.latencyMs ? `${Math.round(p.latencyMs)}MS` : (p.source ?? 'linked').toUpperCase().replace('-', ' '),
        statusTone: p.error || !p.configured ? 'red' : 'fg',
        href: 'config',
        title: p.error ?? p.account,
      });
    }
    for (const a of goog.data ?? []) {
      out.push({
        key: `g:${a.id}`,
        name: a.label || a.email,
        kind: 'GMAIL',
        strength: 100,
        tone: a.error ? 'red' : 'default',
        status: a.error ? 'ERR' : 'LINKED',
        statusTone: a.error ? 'red' : 'muted',
        href: 'mail',
        title: a.error ?? a.email,
      });
    }
    for (const w of slack.data ?? []) {
      out.push({
        key: `s:${w.id}`,
        name: w.name,
        kind: 'SLACK',
        strength: 100,
        tone: w.error ? 'red' : 'default',
        status: w.error ? 'ERR' : w.tokenType === 'bot' ? 'BOT' : 'LINKED',
        statusTone: w.error ? 'red' : 'muted',
        href: 'slack',
        title: w.error ?? w.user,
      });
    }
    return out.map((l, i) => ({ ...l, code: `LNK-${String(i + 1).padStart(2, '0')}` }));
  }, [prov.data, goog.data, slack.data, activeProvider]);

  const anyData = prov.data !== undefined || goog.data !== undefined || slack.data !== undefined;
  const linked = links.filter((l) => l.tone !== 'red' && l.strength > 0).length;
  const errs = links.filter((l) => l.tone === 'red').length;

  return (
    <Panel
      code="LNK.05"
      title="Uplinks"
      class={props.class}
      noPad
      bodyClass="flex flex-col"
      right={anyData ? <Tag tone={errs ? 'red' : 'plain'}>{`${linked}/${links.length} linked`}</Tag> : undefined}
    >
      {!anyData ? (
        conn.value !== 'open' ? <Offline /> : prov.error ? <PanelNote label="Unavailable" sub={prov.error} /> : <PanelNote label="Scanning" spinner />
      ) : links.length === 0 ? (
        <PanelNote
          label="No uplinks"
          sub="Connect a model provider, Gmail or Slack."
          action={
            <button type="button" class="mt-1 font-mono text-[10px] tracking-[0.14em] uppercase text-fg-2 hover:text-fg underline decoration-line underline-offset-4" onClick={() => navigate('config')}>
              Open Config →
            </button>
          }
        />
      ) : (
        <div class="flex-1 min-h-0 overflow-y-auto px-2 py-1.5">
          {links.map((l) => (
            <button type="button" key={l.key} class="hud-row w-full text-left !py-1.5" onClick={() => navigate(l.href)} title={l.title}>
              <span class={`font-mono text-[11px] tabular-nums w-12 shrink-0 ${l.tone === 'red' ? 'text-red' : 'text-fg'}`}>{l.code}</span>
              <span class="flex-1 min-w-0 flex items-baseline gap-2">
                <span class="font-mono text-[9.5px] tracking-[0.12em] text-fg-3 w-11 shrink-0">{l.kind}</span>
                <span class="text-[12px] text-fg-2 truncate">{l.name}</span>
              </span>
              <SegBar value={l.strength} segments={10} tone={l.tone} class="w-[76px] shrink-0" />
              <span class={`font-mono text-[10px] tracking-[0.08em] tabular-nums w-14 text-right shrink-0 ${l.statusTone === 'red' ? 'text-red' : l.statusTone === 'fg' ? 'text-fg' : 'text-fg-2'}`}>
                {l.status}
              </span>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

function latencyStrength(ms: number): number {
  if (ms <= 150) return 100;
  if (ms >= 3000) return 20;
  return Math.round(100 - ((ms - 150) / 2850) * 80);
}

/* ───────────────────────── COM.06 ───────────────────────── */

export function LogPanel(props: { class?: string }) {
  const entries = useMemo(() => activityLog.value.slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 60), [activityLog.value]);
  const ph = phase.value;
  const online = conn.value === 'open';
  const busy = online && ph !== 'idle';
  return (
    <Panel
      code="COM.06"
      title="Assistant log"
      class={props.class}
      noPad
      bodyClass="flex flex-col"
      active={busy}
      right={<Tag tone={!online ? 'plain' : busy ? 'red' : 'default'}>{!online ? 'Offline' : busy ? ph.replace('-', ' ') : 'Listening'}</Tag>}
    >
      {entries.length === 0 ? (
        online ? <PanelNote label="Log empty" sub="Assistant activity will appear here." /> : <Offline />
      ) : (
        <ol class="flex-1 min-h-0 overflow-y-auto px-3.5 py-1" aria-label="Assistant activity">
          {entries.map((e) => {
            const err = e.tag === 'ERR' || e.level === 'error';
            return (
              <li key={e.id} class="grid grid-cols-[58px_38px_1fr] gap-2 py-1.5 border-b border-line/50 last:border-b-0">
                <span class="font-mono text-[10.5px] text-fg-3 tabular-nums pt-px">{fmt.timeSec(e.ts)}</span>
                <span class={`font-mono text-[10.5px] tracking-[0.06em] pt-px ${err ? 'text-red' : e.level === 'warn' ? 'text-warning' : e.tag === 'AGT' ? 'text-red/80' : 'text-fg-3'}`}>{e.tag}</span>
                {e.sessionId ? (
                  <a href={`#/comms/${e.sessionId}`} class={`text-[12px] leading-snug line-clamp-2 hover:text-fg ${err ? 'text-fg' : 'text-fg-2'}`} title={e.text}>
                    {e.text}
                  </a>
                ) : (
                  <span class={`text-[12px] leading-snug line-clamp-2 ${err ? 'text-fg' : 'text-fg-2'}`} title={e.text}>
                    {e.text}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
