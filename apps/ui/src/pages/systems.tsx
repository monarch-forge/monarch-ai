/**
 * Systems — detailed machine + core telemetry.
 * OWNED BY UI-A.
 */
import { useMemo, useState } from 'preact/hooks';
import type { ProcessInfo, SystemInfo, SystemMetrics } from '@monarch/shared';
import { conn, health, metrics, metricsHistory, phase, settings, useResource } from '../lib/store.ts';
import { Panel, SegBar, Sparkline, Stat, Tag, fmt, useNow } from '../components/ui.tsx';
import { Gate, Offline, PanelNote, tone85 } from '../components/overview/common.tsx';

export default function SystemsPage(_props: { params: string[] }) {
  const info = useResource<SystemInfo>('/system/info');
  const m = metrics.value;
  const hist = metricsHistory.value;
  return (
    <div class="h-full overflow-y-auto">
      <div class="grid grid-cols-1 lg:grid-cols-6 xl:grid-cols-12 gap-3 p-3 xl:p-4">
        <Panel code="SYS.01" title="Host" class="lg:col-span-3 xl:col-span-4" right={info.data ? <Tag tone="plain">{info.data.arch}</Tag> : undefined}>
          <Gate res={info}>{(i) => <HostBody info={i} m={m} />}</Gate>
        </Panel>

        <Panel
          code="SYS.02"
          title="Processor"
          class="lg:col-span-3 xl:col-span-5"
          active={!!m && m.cpu.load >= 85}
          right={m ? <Tag tone={m.cpu.load >= 85 ? 'red' : 'plain'}>{fmt.pct(m.cpu.load)}</Tag> : undefined}
        >
          {m ? <CpuBody m={m} hist={hist} /> : <NoMetrics />}
        </Panel>

        <Panel code="SYS.03" title="Core" class="lg:col-span-6 xl:col-span-3" active={conn.value === 'open' && phase.value !== 'idle'} right={<ConnTag />}>
          <CoreBody />
        </Panel>

        <Panel
          code="SYS.04"
          title="Memory"
          class="lg:col-span-3 xl:col-span-4"
          active={!!m && m.mem.percent >= 85}
          right={m ? <Tag tone={m.mem.percent >= 85 ? 'red' : 'plain'}>{fmt.pct(m.mem.percent)}</Tag> : undefined}
        >
          {m ? <MemBody m={m} hist={hist} /> : <NoMetrics />}
        </Panel>

        <Panel code="SYS.05" title="Network" class="lg:col-span-3 xl:col-span-4" right={m?.net.iface ? <Tag tone="plain">{m.net.iface}</Tag> : undefined}>
          {m ? <NetBody m={m} hist={hist} /> : <NoMetrics />}
        </Panel>

        <Panel code="SYS.06" title="Power" class="lg:col-span-6 xl:col-span-4" right={m ? <Tag tone="plain">{m.battery ? (m.battery.charging ? 'Charging' : 'Battery') : 'AC'}</Tag> : undefined}>
          {m ? <PowerBody m={m} /> : <NoMetrics />}
        </Panel>

        <Panel code="SYS.07" title="Storage" class="lg:col-span-6 xl:col-span-5" noPad right={m ? <Tag tone="plain">{`${m.disk.length} vol`}</Tag> : undefined}>
          {m ? <DisksBody m={m} /> : <NoMetrics />}
        </Panel>

        <ProcessesPanel class="lg:col-span-6 xl:col-span-7" />
      </div>
    </div>
  );
}

function NoMetrics() {
  return conn.value !== 'open' ? <Offline /> : <PanelNote label="Awaiting telemetry" spinner />;
}

function ConnTag() {
  const c = conn.value;
  return <Tag tone={c === 'open' ? 'ok' : c === 'connecting' ? 'warn' : 'red'}>{c === 'open' ? 'Online' : c === 'connecting' ? 'Linking' : 'Offline'}</Tag>;
}

/* ───────── host ───────── */

function HostBody(props: { info: SystemInfo; m: SystemMetrics | null }) {
  const { info, m } = props;
  return (
    <div class="flex flex-col gap-3.5">
      <div>
        <div class="font-mono text-[22px] font-light tracking-tight text-fg truncate">{info.hostname}</div>
        <div class="font-mono text-[11px] text-fg-3 mt-1 truncate" title={info.cpuModel}>
          {info.platform} {info.release} · {info.cpuModel}
        </div>
      </div>
      <div class="grid grid-cols-3 gap-3 border-t border-line pt-3">
        <Stat label="Cores" value={info.cpuCores} />
        <Stat label="Memory" value={fmt.bytes(info.totalMemBytes, 0)} />
        <Stat label="Uptime" value={m ? fmt.uptime(m.uptimeSec) : '—'} />
        <Stat label="Booted" value={fmt.dateTime(info.bootTime)} class="col-span-2" />
        <Stat label="Node" value={info.nodeVersion} />
      </div>
    </div>
  );
}

/* ───────── cpu ───────── */

function CpuBody(props: { m: SystemMetrics; hist: SystemMetrics[] }) {
  const { m, hist } = props;
  const cores = m.cpu.perCore ?? [];
  const series = hist.map((h) => h.cpu.load);
  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-end justify-between gap-4">
        <div class="flex items-baseline gap-1">
          <span class="font-mono font-light text-[34px] leading-none tabular-nums text-fg">{Math.round(m.cpu.load)}</span>
          <span class="font-mono text-[12px] text-fg-3">%</span>
        </div>
        <div class="flex gap-5">
          {typeof m.cpu.tempC === 'number' && <Stat label="Temp" value={<span class={m.cpu.tempC >= 85 ? 'text-red' : ''}>{Math.round(m.cpu.tempC)}°C</span>} />}
          <Stat label="Load avg" value={(m.loadAvg ?? [0, 0, 0]).map((l) => l.toFixed(2)).join('  ')} />
        </div>
      </div>
      <div>
        <Sparkline values={series.length > 1 ? series : [m.cpu.load, m.cpu.load]} height={44} min={0} max={100} />
        <div class="flex justify-between font-mono text-[9px] tracking-[0.1em] text-fg-3 mt-0.5">
          <span>−{Math.max(series.length, 1)} SAMPLES</span>
          <span>NOW</span>
        </div>
      </div>
      {cores.length > 0 && (
        <div class="border-t border-line pt-3">
          <div class="hud-label text-[10px] mb-2">Per core</div>
          <div class="flex items-end gap-[3px] h-14">
            {cores.map((c, i) => (
              <div key={i} class="flex-1 h-full bg-subtle relative min-w-[3px]" title={`Core ${i}: ${fmt.pct(c)}`}>
                <div class={`absolute bottom-0 inset-x-0 ${c >= 85 ? 'bg-red' : 'bg-fg-2'}`} style={{ height: `${Math.max(1, Math.min(100, c))}%` }} />
              </div>
            ))}
          </div>
          {cores.length <= 32 && (
            <div class="flex gap-[3px] mt-1">
              {cores.map((_, i) => (
                <span key={i} class="flex-1 text-center font-mono text-[8.5px] text-fg-3 tabular-nums min-w-[3px]">
                  {cores.length <= 16 || i % 2 === 0 ? i : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────── memory ───────── */

function MemBody(props: { m: SystemMetrics; hist: SystemMetrics[] }) {
  const { m, hist } = props;
  const series = hist.map((h) => h.mem.percent);
  return (
    <div class="flex flex-col gap-3">
      <MeterRow label="RAM" pct={m.mem.percent} detail={`${fmt.bytes(m.mem.usedBytes)} / ${fmt.bytes(m.mem.totalBytes)}`} />
      {m.swap && m.swap.totalBytes > 0 ? (
        <MeterRow label="Swap" pct={m.swap.percent} detail={`${fmt.bytes(m.swap.usedBytes)} / ${fmt.bytes(m.swap.totalBytes)}`} />
      ) : (
        <div class="grid grid-cols-[44px_1fr] gap-3 items-center">
          <span class="hud-label text-[10px]">Swap</span>
          <span class="font-mono text-[11px] text-fg-3">none</span>
        </div>
      )}
      <div class="border-t border-line pt-3">
        <Sparkline values={series.length > 1 ? series : [m.mem.percent, m.mem.percent]} height={44} min={0} max={100} />
        <div class="flex justify-between font-mono text-[9px] tracking-[0.1em] text-fg-3 mt-0.5">
          <span>RAM HISTORY</span>
          <span>NOW</span>
        </div>
      </div>
    </div>
  );
}

function MeterRow(props: { label: string; pct: number; detail: string }) {
  return (
    <div class="grid grid-cols-[44px_1fr_auto] gap-3 items-center">
      <span class="hud-label text-[10px]">{props.label}</span>
      <SegBar value={props.pct} segments={24} tone={tone85(props.pct)} />
      <span class={`hud-value text-[11px] text-right min-w-[150px] ${props.pct >= 85 ? 'text-red' : ''}`}>
        <span class="text-fg-2">{props.detail}</span> · {fmt.pct(props.pct)}
      </span>
    </div>
  );
}

/* ───────── network ───────── */

function NetBody(props: { m: SystemMetrics; hist: SystemMetrics[] }) {
  const { m, hist } = props;
  const rx = hist.map((h) => h.net.rxBytesPerSec);
  const tx = hist.map((h) => h.net.txBytesPerSec);
  const max = Math.max(1, ...rx, ...tx);
  return (
    <div class="flex flex-col gap-3">
      <NetSeries label="↓ RX" now={m.net.rxBytesPerSec} values={rx} max={max} peak={Math.max(0, ...rx)} />
      <NetSeries label="↑ TX" now={m.net.txBytesPerSec} values={tx} max={max} peak={Math.max(0, ...tx)} />
    </div>
  );
}

function NetSeries(props: { label: string; now: number; values: number[]; max: number; peak: number }) {
  return (
    <div>
      <div class="flex items-baseline justify-between">
        <span class="hud-label text-[10px]">{props.label}</span>
        <span class="hud-value text-[13px]">
          {fmt.bytes(props.now)}/s <span class="text-fg-3 text-[10px] ml-1">PEAK {fmt.bytes(props.peak)}/s</span>
        </span>
      </div>
      <Sparkline values={props.values.length > 1 ? props.values : [props.now, props.now]} height={36} min={0} max={props.max} class="mt-1" />
    </div>
  );
}

/* ───────── power ───────── */

function PowerBody(props: { m: SystemMetrics }) {
  const { m } = props;
  const b = m.battery;
  return (
    <div class="flex flex-col gap-3">
      {b ? (
        <>
          <div class="flex items-baseline gap-1">
            <span class="font-mono font-light text-[34px] leading-none tabular-nums text-fg">{Math.round(b.percent)}</span>
            <span class="font-mono text-[12px] text-fg-3">%</span>
            <span class="ml-auto font-mono text-[10px] tracking-[0.14em] uppercase text-fg-2">{b.charging ? 'On AC · charging' : 'Discharging'}</span>
          </div>
          <SegBar value={b.percent} segments={24} tone={b.percent <= 15 && !b.charging ? 'red' : 'default'} />
        </>
      ) : (
        <div class="font-mono text-[11px] tracking-[0.12em] uppercase text-fg-3">No battery · mains power</div>
      )}
      <div class="grid grid-cols-2 gap-3 border-t border-line pt-3">
        <Stat label="Uptime" value={fmt.uptime(m.uptimeSec)} />
        <Stat label="Sampled" value={fmt.timeSec(m.ts)} />
      </div>
    </div>
  );
}

/* ───────── disks ───────── */

function DisksBody(props: { m: SystemMetrics }) {
  const disks = props.m.disk ?? [];
  if (!disks.length) return <PanelNote label="No volumes reported" />;
  return (
    <div class="overflow-x-auto">
      <table class="w-full text-[12px]">
        <thead>
          <tr class="hud-label text-[10px] text-left">
            <th class="font-normal px-3.5 py-2">Mount</th>
            <th class="font-normal px-2 py-2 w-[40%]">Usage</th>
            <th class="font-normal px-2 py-2 text-right">Used</th>
            <th class="font-normal px-2 py-2 text-right">Total</th>
            <th class="font-normal px-3.5 py-2 text-right">%</th>
          </tr>
        </thead>
        <tbody>
          {disks.map((d) => (
            <tr key={d.mount} class="border-t border-line/60">
              <td class="px-3.5 py-2 font-mono text-fg-2 truncate max-w-[180px]" title={d.mount}>
                {d.mount}
              </td>
              <td class="px-2 py-2">
                <SegBar value={d.percent} segments={20} tone={tone85(d.percent)} />
              </td>
              <td class="px-2 py-2 hud-value text-right text-fg-2">{fmt.bytes(d.usedBytes)}</td>
              <td class="px-2 py-2 hud-value text-right text-fg-2">{fmt.bytes(d.totalBytes)}</td>
              <td class={`px-3.5 py-2 hud-value text-right ${d.percent >= 85 ? 'text-red' : ''}`}>{fmt.pct(d.percent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────── core health ───────── */

function CoreBody() {
  const now = useNow(1000);
  const h = health.value;
  const s = settings.value;
  const c = conn.value;
  if (c !== 'open' && !h) return <Offline />;
  const up = h ? Math.max(0, (now.getTime() - Date.parse(h.startedAt)) / 1000) : 0;
  const model = s ? (s.engine === 'claude-sdk' ? s.claudeSdk.model : `${s.pi.provider}/${s.pi.model}`) : h?.model;
  return (
    <div class="flex flex-col gap-3">
      <div class="grid grid-cols-2 gap-3">
        <Stat label="Version" value={h?.version ?? '—'} />
        <Stat label="Protocol" value={h ? `v${h.protocol}` : '—'} />
        <Stat label="Uptime" value={h ? fmt.uptime(up) : '—'} />
        <Stat label="Phase" value={<span class={phase.value !== 'idle' && c === 'open' ? 'text-red' : ''}>{c === 'open' ? phase.value.toUpperCase() : '—'}</span>} />
      </div>
      <div class="border-t border-line pt-3 grid grid-cols-1 gap-3">
        <Stat label="Engine" value={s?.engine ?? h?.engine ?? '—'} />
        <Stat label="Model" value={<span class="truncate block" title={model}>{model ?? '—'}</span>} />
      </div>
      {c !== 'open' && <div class="font-mono text-[10px] tracking-[0.14em] uppercase text-red">Link lost · showing last known</div>}
    </div>
  );
}

/* ───────── processes ───────── */

type SortKey = 'cpu' | 'mem' | 'name' | 'pid';

function ProcessesPanel(props: { class?: string }) {
  const res = useResource<ProcessInfo[]>('/system/processes?limit=20', [], { intervalMs: 5000 });
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cpu', desc: true });
  const rows = useMemo(() => {
    const list = (res.data ?? []).slice();
    const dir = sort.desc ? -1 : 1;
    list.sort((a, b) => {
      const va = sort.key === 'cpu' ? a.cpu : sort.key === 'mem' ? a.memBytes : sort.key === 'pid' ? a.pid : a.name.toLowerCase();
      const vb = sort.key === 'cpu' ? b.cpu : sort.key === 'mem' ? b.memBytes : sort.key === 'pid' ? b.pid : b.name.toLowerCase();
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    return list;
  }, [res.data, sort]);
  const totalMem = metrics.value?.mem.totalBytes ?? 0;

  const th = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => (
    <th class={`font-normal px-2 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        class={`hud-label text-[10px] hover:text-fg-2 ${sort.key === key ? '!text-fg-2' : ''}`}
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}
      >
        {label}
        {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );

  return (
    <Panel code="SYS.08" title="Top processes" class={props.class} noPad right={<Tag tone="plain">5s refresh</Tag>}>
      <Gate res={res}>
        {() =>
          rows.length === 0 ? (
            <PanelNote label="No processes reported" />
          ) : (
            <div class="overflow-x-auto">
              <table class="w-full text-[12px]">
                <thead>
                  <tr>
                    <th class="w-1 pl-1.5" />
                    {th('pid', 'PID')}
                    {th('name', 'Process')}
                    <th class="font-normal px-2 py-2 text-left hud-label text-[10px] hidden lg:table-cell">User</th>
                    {th('cpu', 'CPU', 'right')}
                    {th('mem', 'Mem', 'right')}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const hot = p.cpu >= 85;
                    return (
                      <tr key={p.pid} class="border-t border-line/60 hover:bg-white/[0.02]">
                        <td class="pl-1.5">
                          <span class={`block w-[2px] h-4 ${hot ? 'bg-red' : 'bg-transparent'}`} />
                        </td>
                        <td class="px-2 py-1.5 hud-value text-fg-3">{p.pid}</td>
                        <td class="px-2 py-1.5 max-w-[320px]">
                          <div class="truncate text-fg-2" title={p.command ?? p.name}>
                            <span class="text-fg">{p.name}</span>
                            {p.command && p.command !== p.name && <span class="font-mono text-[10.5px] text-fg-3 ml-2">{p.command}</span>}
                          </div>
                        </td>
                        <td class="px-2 py-1.5 font-mono text-[11px] text-fg-3 hidden lg:table-cell truncate max-w-[120px]">{p.user ?? '—'}</td>
                        <td class={`px-2 py-1.5 hud-value text-right ${hot ? 'text-red' : ''}`}>{p.cpu.toFixed(1)}%</td>
                        <td class="px-2 py-1.5 pr-3.5 hud-value text-right text-fg-2">
                          {fmt.bytes(p.memBytes)}
                          {totalMem > 0 && <span class="text-fg-3 text-[10px] ml-1.5">{((p.memBytes / totalMem) * 100).toFixed(1)}%</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </Gate>
    </Panel>
  );
}
