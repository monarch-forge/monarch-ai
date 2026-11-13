/** Overview left column: ENV.01 conditions, CAL.02 schedule, SYS.03 vitals. OWNED BY UI-A. */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { CalendarEvent, Weather } from '@monarch/shared';
import { conn, metrics, metricsHistory, navigate, settings, useResource } from '../../lib/store.ts';
import { Panel, SegBar, Tag, fmt, useNow } from '../ui.tsx';
import { Gate, KV, Offline, PanelNote, dayKey, endOfDay, startOfDay, tone85 } from './common.tsx';

/* ───────────────────────── ENV.01 ───────────────────────── */

const imperial = () => settings.value?.user.units === 'imperial';
const temp = (c: number) => (imperial() ? (c * 9) / 5 + 32 : c);
const tempUnit = () => (imperial() ? '°F' : '°C');
const speed = (kph: number) => (imperial() ? `${Math.round(kph * 0.621)} MPH` : `${Math.round(kph)} KM/H`);
const dist = (km?: number) => (km === undefined || km === null ? '—' : imperial() ? `${Math.round(km * 0.621)} MI` : `${Math.round(km)} KM`);

export function EnvPanel(props: { class?: string }) {
  const res = useResource<Weather>('/weather', ['settings'], { intervalMs: 10 * 60_000 });
  const noLocation = settings.value ? !settings.value.user.location : false;
  const notFound = !!res.error && /404|location|not set|not found/i.test(res.error);
  const wx = res.data;
  return (
    <Panel
      code="ENV.01"
      title="Local conditions"
      class={props.class}
      right={wx && !noLocation ? <Tag>{wx.current.summary}</Tag> : undefined}
    >
      {noLocation || (notFound && !wx) ? (
        <PanelNote
          label="No location set"
          sub="Set your location so Monarch can track local conditions."
          action={
            <button type="button" class="mt-1 font-mono text-[10px] tracking-[0.14em] uppercase text-fg-2 hover:text-fg underline decoration-line underline-offset-4" onClick={() => navigate('config')}>
              Set location in Config →
            </button>
          }
        />
      ) : (
        <Gate res={res}>{(w) => <WeatherBody wx={w} />}</Gate>
      )}
    </Panel>
  );
}

function WeatherBody(props: { wx: Weather }) {
  const { wx } = props;
  const cur = wx.current;
  const now = Date.now();
  const hours = (wx.hourly ?? []).filter((h) => Date.parse(h.time) >= now - 30 * 60_000).slice(0, 6);
  const loc = wx.location;
  const today = wx.daily?.[0];
  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-start leading-none">
          <span class="font-mono font-light text-[40px] tracking-tight tabular-nums text-fg">{temp(cur.tempC).toFixed(1)}</span>
          <span class="font-mono text-[12px] text-fg-3 mt-1 ml-1">{tempUnit()}</span>
        </div>
        <div class="text-right min-w-0">
          <div class="font-mono text-[12px] tracking-[0.12em] uppercase text-fg truncate">{loc?.name ?? '—'}</div>
          {loc && (
            <div class="font-mono text-[10px] tracking-[0.08em] text-fg-3 mt-1 tabular-nums">
              {Math.abs(loc.lat).toFixed(4)} {loc.lat >= 0 ? 'N' : 'S'} / {Math.abs(loc.lon).toFixed(4)} {loc.lon >= 0 ? 'E' : 'W'}
            </div>
          )}
          {today && (
            <div class="font-mono text-[10px] tracking-[0.12em] uppercase text-fg-2 mt-1 tabular-nums">
              H {Math.round(temp(today.maxC))}° · L {Math.round(temp(today.minC))}°
            </div>
          )}
        </div>
      </div>
      <div class="grid grid-cols-4 gap-2 border-t border-line pt-2.5">
        <KV k="Wind" v={`${speed(cur.windKph)} ${cur.windDir ?? ''}`.trim()} />
        <KV k="Humidity" v={`${Math.round(cur.humidity)}%`} />
        <KV k="Feels" v={`${Math.round(temp(cur.feelsLikeC))}°`} />
        <KV k="Vis" v={dist(cur.visibilityKm)} />
      </div>
      {hours.length > 0 && (
        <div class="grid grid-cols-6 gap-1">
          {hours.map((h) => (
            <div key={h.time} class="bg-[#121213] border border-line/60 py-1.5 text-center">
              <div class="font-mono text-[10px] text-fg-3 tabular-nums">{fmt.time(h.time)}</div>
              <div class="font-mono text-[13px] text-fg tabular-nums mt-0.5">{Math.round(temp(h.tempC))}°</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── CAL.02 ───────────────────────── */

export function SchedulePanel(props: { class?: string }) {
  const now = useNow(1000);
  const key = dayKey(now);
  const path = useMemo(() => `/events?from=${encodeURIComponent(startOfDay(now).toISOString())}&to=${encodeURIComponent(endOfDay(now).toISOString())}`, [key]);
  const res = useResource<CalendarEvent[]>(path, ['events', 'google'], { intervalMs: 5 * 60_000 });

  const events = useMemo(
    () => (res.data ?? []).slice().sort((a, b) => (a.allDay === b.allDay ? Date.parse(a.start) - Date.parse(b.start) : a.allDay ? -1 : 1)),
    [res.data],
  );
  const t = now.getTime();
  const isCurrent = (e: CalendarEvent) => !e.allDay && Date.parse(e.start) <= t && (e.end ? Date.parse(e.end) > t : Date.parse(e.start) + 30 * 60_000 > t);
  const current = events.find(isCurrent);
  const next = events.find((e) => !e.allDay && Date.parse(e.start) > t);
  const focusId = current?.id ?? next?.id;

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-focus="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusId, events.length]);

  let right = undefined;
  if (next) {
    const soon = Date.parse(next.start) - t < 10 * 60_000;
    right = (
      <Tag tone={soon ? 'red' : 'plain'} title={`Next: ${next.title}`}>
        <span class="tabular-nums">{fmt.countdown(next.start, now)}</span>
      </Tag>
    );
  } else if (current) right = <Tag tone="red">In progress</Tag>;
  else if (res.data) right = <Tag tone="plain">Clear</Tag>;

  return (
    <Panel code="CAL.02" title="Today / Schedule" class={props.class} right={right} noPad bodyClass="flex flex-col">
      <Gate res={res}>
        {() =>
          events.length === 0 ? (
            <PanelNote label="Nothing scheduled" sub="Your day is open." />
          ) : (
            <div class="flex flex-col min-h-0 flex-1">
              {next && (
                <div class="flex items-center justify-between px-3.5 pt-2.5 pb-1.5">
                  <span class="hud-label text-[10px]">Next event</span>
                  <span class="font-mono text-[11px] text-fg-2 truncate max-w-[60%]">{next.title}</span>
                </div>
              )}
              <div ref={listRef} class="flex-1 min-h-0 overflow-y-auto px-2 pb-2 pt-1">
                {events.map((e) => {
                  const past = !e.allDay && (e.end ? Date.parse(e.end) <= t : Date.parse(e.start) + 30 * 60_000 <= t);
                  const active = e.id === current?.id;
                  const focus = e.id === focusId;
                  return (
                    <button
                      type="button"
                      key={e.id}
                      data-focus={focus ? 'true' : 'false'}
                      data-active={active || (!current && focus) ? 'true' : 'false'}
                      class="hud-row w-full text-left"
                      onClick={() => navigate('agenda')}
                      title={e.location ? `${e.title} — ${e.location}` : e.title}
                    >
                      <span class={`font-mono text-[11px] tabular-nums w-11 shrink-0 ${past ? 'text-fg-3' : 'text-fg-2'}`}>{e.allDay ? 'ALL' : fmt.time(e.start)}</span>
                      <span class={`flex-1 min-w-0 truncate ${past ? 'text-fg-3' : focus ? 'text-fg' : 'text-fg-2'}`}>{e.title}</span>
                      {e.location && <span class="font-mono text-[10px] tracking-[0.1em] uppercase text-fg-3 truncate max-w-[34%]">{shortLoc(e.location)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )
        }
      </Gate>
    </Panel>
  );
}

function shortLoc(s: string): string {
  if (/^https?:\/\//.test(s)) return 'LINK';
  if (/meet\.google|zoom\.us|teams\.microsoft/i.test(s)) return 'CALL';
  return s.split(',')[0].slice(0, 18);
}

/* ───────────────────────── SYS.03 ───────────────────────── */

export function VitalsPanel(props: { class?: string }) {
  const m = metrics.value;
  const hist = metricsHistory.value;
  const tempC = m?.cpu.tempC;
  if (!m) {
    return (
      <Panel code="SYS.03" title="Vitals" class={props.class}>
        {conn.value !== 'open' ? <Offline /> : <PanelNote label="Awaiting telemetry" spinner />}
      </Panel>
    );
  }
  const disk = m.disk.find((d) => d.mount === '/') ?? m.disk.slice().sort((a, b) => b.totalBytes - a.totalBytes)[0];
  const netNow = m.net.rxBytesPerSec + m.net.txBytesPerSec;
  const netMax = Math.max(1, ...hist.map((h) => h.net.rxBytesPerSec + h.net.txBytesPerSec), netNow);
  const hot = m.cpu.load >= 85 || m.mem.percent >= 85 || (disk?.percent ?? 0) >= 85;
  return (
    <Panel
      code="SYS.03"
      title="Vitals"
      class={props.class}
      active={hot}
      right={
        <>
          {typeof tempC === 'number' && <Tag tone={tempC >= 85 ? 'red' : 'plain'}>{Math.round(tempC)}°C</Tag>}
          <Tag tone={hot ? 'red' : 'plain'}>{hot ? 'Load high' : 'Nominal'}</Tag>
        </>
      }
    >
      <div class="flex flex-col gap-2.5">
        <VitalRow label="CPU" pct={m.cpu.load} value={fmt.pct(m.cpu.load)} />
        <VitalRow label="MEM" pct={m.mem.percent} value={fmt.pct(m.mem.percent)} sub={`${fmt.bytes(m.mem.usedBytes)}`} />
        {disk && <VitalRow label="DISK" pct={disk.percent} value={fmt.pct(disk.percent)} sub={disk.mount} />}
        <VitalRow
          label="NET"
          pct={(netNow / netMax) * 100}
          plain
          value={
            <span>
              <span class="text-fg-3">↓</span>
              {fmt.bytes(m.net.rxBytesPerSec, 0)}/s <span class="text-fg-3 ml-1">↑</span>
              {fmt.bytes(m.net.txBytesPerSec, 0)}/s
            </span>
          }
          wide
        />
      </div>
    </Panel>
  );
}

function VitalRow(props: { label: string; pct: number; value: ComponentChildren; sub?: string; plain?: boolean; wide?: boolean }) {
  return (
    <div class="grid grid-cols-[36px_1fr_auto] items-center gap-3">
      <span class="hud-label text-[10px]">{props.label}</span>
      <SegBar value={props.pct} segments={20} tone={props.plain ? 'default' : tone85(props.pct)} />
      <span class={`hud-value text-[11px] text-right ${props.wide ? 'min-w-[128px]' : 'min-w-[44px]'} ${!props.plain && props.pct >= 85 ? 'text-red' : ''}`} title={props.sub}>
        {props.value}
      </span>
    </div>
  );
}
