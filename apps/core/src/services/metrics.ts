/** System metrics (systeminformation), broadcast every 2s over WS while at least one client is connected. */
import os from 'node:os';
import si from 'systeminformation';
import type { ProcessInfo, SystemInfo, SystemMetrics } from '@monarch/shared';
import { bus } from '../kernel.ts';
import { CORE_VERSION } from './meta.ts';

const INTERVAL_MS = 2000;

let clientCount = 0;
/** server.ts reports the number of connected WS clients */
export function setClientCount(n: number): void {
  clientCount = Math.max(0, n);
}

/* slow probes are cached with their own TTL */
function cached<T>(ttlMs: number, fn: () => Promise<T>, fallback: T): () => Promise<T> {
  let value = fallback;
  let at = 0;
  let inflight: Promise<T> | null = null;
  return async () => {
    if (Date.now() - at < ttlMs) return value;
    inflight ??= fn()
      .then((v) => {
        value = v;
        at = Date.now();
        return v;
      })
      .catch(() => {
        at = Date.now();
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

const IGNORED_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'efivarfs', 'ramfs', 'fuse.portal', 'nsfs', 'autofs']);
const IGNORED_MOUNT = /^\/(snap|run|sys|proc|dev|var\/lib\/docker|var\/snap|boot\/efi|efi)(\/|$)/;

const disks = cached<SystemMetrics['disk']>(
  30_000,
  async () => {
    const list = await si.fsSize();
    const seen = new Map<string, SystemMetrics['disk'][number]>();
    for (const f of list) {
      if (IGNORED_FS.has(f.type) || IGNORED_MOUNT.test(f.mount) || !f.size || f.size < 1e9) continue;
      const prev = seen.get(f.fs);
      if (prev && prev.mount.length <= f.mount.length) continue; // btrfs subvolumes: keep the shortest mount
      seen.set(f.fs, {
        mount: f.mount,
        usedBytes: f.used,
        totalBytes: f.size,
        percent: Math.round((f.use ?? (f.used / f.size) * 100) * 10) / 10,
      });
    }
    return [...seen.values()].sort((a, b) => a.mount.length - b.mount.length).slice(0, 6);
  },
  [],
);

const battery = cached<SystemMetrics['battery']>(
  60_000,
  async () => {
    const b = await si.battery();
    return b.hasBattery ? { percent: Math.round(b.percent), charging: !!b.isCharging } : null;
  },
  null,
);

const cpuTemp = cached<number | null>(
  10_000,
  async () => {
    const t = await si.cpuTemperature();
    return typeof t.main === 'number' && t.main > 0 ? Math.round(t.main) : null;
  },
  null,
);

const round1 = (x: number) => Math.round(x * 10) / 10;

let last: SystemMetrics | null = null;
let sampling: Promise<SystemMetrics> | null = null;

/** take a fresh sample (coalesces concurrent callers) */
export function sampleMetrics(): Promise<SystemMetrics> {
  sampling ??= (async () => {
    const [load, mem, net, disk, bat, temp] = await Promise.all([
      si.currentLoad().catch(() => null),
      si.mem().catch(() => null),
      si.networkStats().catch(() => []),
      disks(),
      battery(),
      cpuTemp(),
    ]);
    const n = net[0];
    const totalMem = mem?.total ?? os.totalmem();
    const usedMem = mem ? mem.active : os.totalmem() - os.freemem();
    const la = os.loadavg();
    const m: SystemMetrics = {
      ts: new Date().toISOString(),
      cpu: {
        load: round1(load?.currentLoad ?? 0),
        perCore: (load?.cpus ?? []).map((c) => round1(c.load)),
        tempC: temp,
      },
      mem: { usedBytes: usedMem, totalBytes: totalMem, percent: round1((usedMem / totalMem) * 100) },
      swap:
        mem && mem.swaptotal > 0
          ? { usedBytes: mem.swapused, totalBytes: mem.swaptotal, percent: round1((mem.swapused / mem.swaptotal) * 100) }
          : undefined,
      disk,
      net: {
        rxBytesPerSec: Math.max(0, Math.round(n?.rx_sec ?? 0)),
        txBytesPerSec: Math.max(0, Math.round(n?.tx_sec ?? 0)),
        iface: n?.iface,
      },
      battery: bat,
      uptimeSec: Math.round(os.uptime()),
      loadAvg: [round1(la[0]), round1(la[1]), round1(la[2])],
    };
    last = m;
    return m;
  })().finally(() => {
    sampling = null;
  });
  return sampling;
}

export function lastMetrics(): SystemMetrics | null {
  return last;
}

/** cached sample if younger than maxAgeMs, else a fresh one */
export async function getMetrics(maxAgeMs = 2500): Promise<SystemMetrics> {
  if (last && Date.now() - Date.parse(last.ts) < maxAgeMs) return last;
  return sampleMetrics();
}

let timer: NodeJS.Timeout | null = null;
export function startMetrics(): void {
  if (timer) return;
  // prime the delta-based probes (cpu load, net rates)
  sampleMetrics().catch(() => {});
  timer = setInterval(() => {
    if (clientCount < 1 || sampling) return;
    sampleMetrics()
      .then((metrics) => bus.broadcast({ type: 'metrics', metrics }))
      .catch((e) => console.error('[metrics] sample failed:', e));
  }, INTERVAL_MS);
}
export function stopMetrics(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

let info: SystemInfo | null = null;
export async function systemInfo(): Promise<SystemInfo> {
  if (info) return info;
  const [osi, cpu] = await Promise.all([si.osInfo().catch(() => null), si.cpu().catch(() => null)]);
  const cpus = os.cpus();
  info = {
    hostname: os.hostname(),
    platform: osi?.distro || os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: cpu ? `${cpu.manufacturer} ${cpu.brand}`.trim() : (cpus[0]?.model ?? 'unknown'),
    cpuCores: cpu?.cores || cpus.length,
    totalMemBytes: os.totalmem(),
    bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(),
    nodeVersion: process.version,
    coreVersion: CORE_VERSION,
  };
  return info;
}

export async function topProcesses(limit = 15, sortBy: 'cpu' | 'mem' = 'cpu'): Promise<ProcessInfo[]> {
  const p = await si.processes();
  return p.list
    .map(
      (x): ProcessInfo => ({
        pid: x.pid,
        name: x.name,
        cpu: round1(x.cpu),
        memBytes: (x.memRss ?? 0) * 1024,
        user: x.user || undefined,
        command: [x.command, x.params].filter(Boolean).join(' ').slice(0, 300) || undefined,
      }),
    )
    .sort((a, b) => (sortBy === 'mem' ? b.memBytes - a.memBytes : b.cpu - a.cpu || b.memBytes - a.memBytes))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

export function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
