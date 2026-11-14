/**
 * ExtensionManager — process lifecycle of extension hosts.
 *
 * Every enabled extension runs in its OWN Node child process (host.ts) under the Node permission model:
 *   --permission
 *   --allow-fs-read=<host script>,<extension dir>      (+ home dir and tmp with the 'fs' permission)
 *   --allow-fs-write=<extension data dir>              (+ home dir and tmp with the 'fs' permission)
 *   --allow-child-process                              only with 'shell'
 *   --allow-net                                        only with 'network' (Node ≥ 25; older Node: unrestricted)
 *   --max-old-space-size=256
 * The child gets a minimal environment (no API keys from the core's env).
 *
 * Crash policy: restart with backoff (1s, 2s, 4s); more than 3 crashes within 2 minutes → status 'error'.
 * Timeouts: activation 10s, tool calls 60s, panel renders 15s, jobs 5 min.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionManifest, ExtensionStatus, PanelContent, ToolRisk } from '@monarch/shared';
import { activity, changed, notify, nowIso, paths, secrets } from '../kernel.ts';
import type { CoreToHost, HostBoot, HostRegistry, HostToCore } from './ipc.ts';
import { appendLog, extDataDir, extDir, extEntry, getState, patchState, readManifest } from './store.ts';
import { record } from './timeline.ts';

const ACTIVATE_TIMEOUT = 10_000;
const CALL_TIMEOUT = 60_000;
const PANEL_TIMEOUT = 15_000;
const JOB_TIMEOUT = 5 * 60_000;
const CRASH_WINDOW = 120_000;
const MAX_CRASHES = 3;

/* ─────────────── runtime capabilities ─────────────── */

interface Sandbox {
  /** '--permission' | '--experimental-permission' | null (permission model unavailable) */
  flag: string | null;
  /** --allow-net exists → network is denied unless granted */
  net: boolean;
  disableWarning: boolean;
}
let sandbox: Sandbox | null = null;

function detectSandbox(): Sandbox {
  if (sandbox) return sandbox;
  const flags = process.allowedNodeEnvironmentFlags;
  let flag: string | null = flags.has('--permission') ? '--permission' : flags.has('--experimental-permission') ? '--experimental-permission' : null;
  if (flag) {
    const probe = spawnSync(process.execPath, [flag, '-e', '0'], { stdio: 'ignore', timeout: 10_000, env: minimalEnv() });
    if (probe.status !== 0) flag = null;
  }
  sandbox = { flag, net: !!flag && flags.has('--allow-net'), disableWarning: flags.has('--disable-warning') };
  if (!flag) {
    console.warn('[ext] Node permission model unavailable — extensions run isolated in child processes but WITHOUT fs/net restrictions');
    activity('EXT', `Node ${process.version} has no permission model — extensions are process-isolated only (no fs/net sandbox)`, 'warn');
  } else if (!sandbox.net) {
    activity('EXT', `Node ${process.version} cannot restrict network access (needs Node ≥ 25) — the 'network' permission is advisory`, 'warn');
  }
  return sandbox;
}

export function sandboxInfo(): Sandbox {
  return detectSandbox();
}

function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SYSTEMROOT']) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

/* ─────────────── host script resolution ─────────────── */

let hostPathPromise: Promise<string> | null = null;

/**
 * Bundle mode: dist/extension-host.mjs next to core.mjs.
 * Dev (tsx): build src/extensions/host.ts with esbuild into <home>/cache/extension-host.mjs, so the
 * sandboxed child only ever needs read access to ONE self-contained file (no tsx loader, no node_modules).
 */
export function hostScript(): Promise<string> {
  hostPathPromise ??= (async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const bundled = join(here, 'extension-host.mjs');
    if (existsSync(bundled)) return bundled;
    const src = join(here, 'host.ts');
    if (!existsSync(src)) throw new Error(`extension host not found (looked for ${bundled})`);
    const out = join(paths.home, 'cache', 'extension-host.mjs');
    mkdirSync(dirname(out), { recursive: true });
    const esbuildName = 'esbuild'; // non-literal: keeps the production bundle from inlining esbuild
    const { build } = (await import(esbuildName)) as { build: (o: Record<string, unknown>) => Promise<unknown> };
    await build({ entryPoints: [src], outfile: out, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
    return out;
  })().catch((e) => {
    hostPathPromise = null;
    throw e;
  });
  return hostPathPromise;
}

/* ─────────────── runtime state ─────────────── */

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (text: string) => void;
}

interface Runtime {
  id: string;
  manifest: ExtensionManifest;
  proc: ChildProcess | null;
  status: ExtensionStatus;
  error?: string;
  registry: HostRegistry | null;
  pending: Map<number, Pending>;
  seq: number;
  crashes: number[];
  jobTimers: NodeJS.Timeout[];
  restartTimer: NodeJS.Timeout | null;
  notifyTimes: number[];
  /** recent stderr lines (for crash reports) */
  tail: string[];
}

const runtimes = new Map<string, Runtime>();
let registryVersion = 0;

export function runtimeOf(id: string): Runtime | undefined {
  return runtimes.get(id);
}

/** bumps whenever any active extension's tool registry changes (tool def cache key) */
export function registryGeneration(): number {
  return registryVersion;
}

export function statusOf(id: string): { status: ExtensionStatus; error?: string } {
  const rt = runtimes.get(id);
  const st = getState(id);
  if (!rt) return { status: st?.enabled ? 'starting' : 'disabled' };
  return { status: rt.status, error: rt.error };
}

export function activeRuntimes(): Runtime[] {
  return [...runtimes.values()].filter((r) => r.status === 'active' && r.registry);
}

function setStatus(rt: Runtime, status: ExtensionStatus, error?: string): void {
  const changedStatus = rt.status !== status || rt.error !== error;
  rt.status = status;
  rt.error = error;
  if (changedStatus) changed('extensions');
}

/* ─────────────── sanitizing host messages ─────────────── */

const RISKS: ToolRisk[] = ['safe', 'sensitive', 'dangerous'];

function sanitizeRegistry(raw: unknown): HostRegistry {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  return {
    tools: arr(r.tools)
      .filter((t) => typeof t.name === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(t.name))
      .slice(0, 64)
      .map((t) => ({
        name: t.name as string,
        description: String(t.description ?? '').slice(0, 1000),
        risk: RISKS.includes(t.risk as ToolRisk) ? (t.risk as ToolRisk) : 'sensitive',
        schema: t.schema && typeof t.schema === 'object' && !Array.isArray(t.schema) ? (t.schema as Record<string, unknown>) : { type: 'object' },
      })),
    panels: arr(r.panels)
      .filter((p) => typeof p.id === 'string')
      .slice(0, 16)
      .map((p) => ({ id: String(p.id).slice(0, 48), title: String(p.title ?? p.id).slice(0, 80) })),
    jobs: arr(r.jobs)
      .filter((j) => typeof j.id === 'string' && Number(j.everyMinutes) >= 1)
      .slice(0, 16)
      .map((j) => ({ id: String(j.id).slice(0, 48), everyMinutes: Math.max(1, Math.round(Number(j.everyMinutes))) })),
  };
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v ? v.slice(0, max) : typeof v === 'number' ? String(v) : undefined;
}

export function sanitizePanel(raw: unknown): PanelContent {
  const r = (raw && typeof raw === 'object' ? raw : { markdown: String(raw ?? '') }) as Record<string, unknown>;
  const out: PanelContent = { updatedAt: nowIso() };
  const title = str(r.title, 120);
  if (title) out.title = title;
  const md = str(r.markdown, 20_000);
  if (md) out.markdown = md;
  if (Array.isArray(r.stats))
    out.stats = r.stats.slice(0, 12).flatMap((s: any) =>
      s && typeof s === 'object' ? [{ label: str(s.label, 60) ?? '', value: str(s.value, 60) ?? '', ...(str(s.hint, 120) ? { hint: str(s.hint, 120) } : {}) }] : [],
    );
  if (Array.isArray(r.items))
    out.items = r.items.slice(0, 50).flatMap((i: any) => {
      if (!i || typeof i !== 'object') return [];
      const href = str(i.href, 2000);
      return [
        {
          title: str(i.title, 300) ?? '',
          ...(str(i.sub, 300) ? { sub: str(i.sub, 300) } : {}),
          ...(href && /^(https?:\/\/|#\/)/.test(href) ? { href } : {}),
        },
      ];
    });
  return out;
}

/* ─────────────── spawning ─────────────── */

function spawnArgs(manifest: ExtensionManifest, host: string): string[] {
  const sb = detectSandbox();
  const perms = new Set(manifest.permissions);
  const args: string[] = [];
  if (sb.flag) {
    args.push(sb.flag);
    const reads = [host, extDir(manifest.id)];
    const writes = [extDataDir(manifest.id)];
    if (perms.has('fs')) {
      reads.push(homedir(), tmpdir());
      writes.push(homedir(), tmpdir());
    }
    for (const r of reads) args.push(`--allow-fs-read=${r}`);
    for (const w of writes) args.push(`--allow-fs-write=${w}`);
    if (perms.has('shell')) args.push('--allow-child-process');
    if (perms.has('network') && sb.net) args.push('--allow-net');
  }
  if (sb.disableWarning) args.push('--disable-warning=ExperimentalWarning');
  args.push('--max-old-space-size=256', host);
  return args;
}

/** SyntaxErrors from import() carry no location; `node --check` (parse only) reports file:line + caret */
function withSyntaxLocation(id: string, error: string | undefined): string | undefined {
  if (!error || !/^SyntaxError/.test(error)) return error;
  const r = spawnSync(process.execPath, ['--check', extEntry(id)], { encoding: 'utf8', timeout: 10_000, env: minimalEnv() });
  const out = (r.stderr || '').split('\n');
  const at = out.findIndex((l) => l.startsWith('SyntaxError'));
  const loc = (at > 0 ? out.slice(0, at) : out.slice(0, 3))
    .map((l) => (l.length > 240 ? `${l.slice(0, 240)}…` : l))
    .join('\n')
    .replace(extDir(id) + '/', '')
    .trim();
  return loc ? `${error.split('\n')[0]}\n${loc}` : error;
}

interface SpawnResult {
  proc: ChildProcess;
  /** resolves once activation finished (ready / fatal / timeout / early exit) */
  activated: Promise<{ ok: boolean; registry?: HostRegistry; error?: string }>;
}

function spawnHost(
  manifest: ExtensionManifest,
  host: string,
  opts: { probe: boolean; onMessage: (m: HostToCore) => void; onLine: (level: 'info' | 'warn', text: string) => void },
): SpawnResult {
  mkdirSync(extDataDir(manifest.id), { recursive: true });
  const boot: HostBoot = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    permissions: manifest.permissions,
    secrets: manifest.secrets ?? [],
    entry: extEntry(manifest.id),
    dataDir: extDataDir(manifest.id),
    probe: opts.probe,
    netEnforced: detectSandbox().net,
  };
  const proc = spawn(process.execPath, spawnArgs(manifest, host), {
    cwd: extDataDir(manifest.id),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: minimalEnv({ MONARCH_EXT_BOOT: JSON.stringify(boot), MONARCH_EXTENSION: manifest.id }),
    serialization: 'json',
  });
  const lines = (level: 'info' | 'warn') => {
    let buf = '';
    return (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      if (buf.length > 4000) {
        parts.push(buf);
        buf = '';
      }
      for (const l of parts) if (l.trim()) opts.onLine(level, l);
    };
  };
  proc.stdout?.on('data', lines('info'));
  proc.stderr?.on('data', lines('warn'));

  const activated = new Promise<{ ok: boolean; registry?: HostRegistry; error?: string }>((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; registry?: HostRegistry; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      done({ ok: false, error: `activation timed out after ${ACTIVATE_TIMEOUT / 1000}s (does activate() await something that never resolves?)` });
      proc.kill('SIGKILL');
    }, ACTIVATE_TIMEOUT);
    proc.on('message', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const m = raw as HostToCore;
      if (m.t === 'ready') done({ ok: true, registry: sanitizeRegistry(m.registry) });
      else if (m.t === 'fatal') done({ ok: false, error: String(m.error ?? 'activation failed').slice(0, 4000) });
      opts.onMessage(m);
    });
    proc.on('error', (e) => done({ ok: false, error: `could not start host: ${e.message}` }));
    proc.on('exit', (code, signal) => done({ ok: false, error: `host exited during activation (${signal ?? `code ${code}`})` }));
  });
  return { proc, activated };
}

/* ─────────────── start / stop ─────────────── */

function onHostMessage(rt: Runtime, proc: ChildProcess, m: HostToCore): void {
  if (rt.proc !== proc) return;
  switch (m.t) {
    case 'registry':
      if (rt.status === 'active') {
        rt.registry = sanitizeRegistry(m.registry);
        patchState(rt.id, (s) => (s.registry = rt.registry!));
        registryVersion++;
        armJobs(rt);
        changed('extensions');
      }
      return;
    case 'result':
    case 'progress': {
      const p = rt.pending.get(Number(m.id));
      if (!p) return;
      if (m.t === 'progress') {
        p.onProgress?.(String(m.text ?? '').slice(0, 2000));
        return;
      }
      rt.pending.delete(Number(m.id));
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.output);
      else p.reject(new Error(String(m.error ?? 'failed').slice(0, 8000)));
      return;
    }
    case 'log': {
      const level = m.level === 'warn' || m.level === 'error' ? m.level : 'info';
      appendLog(rt.id, level, String(m.text ?? ''));
      return;
    }
    case 'notify': {
      const now = Date.now();
      rt.notifyTimes = rt.notifyTimes.filter((t) => now - t < 60_000);
      if (rt.notifyTimes.length >= 5) {
        appendLog(rt.id, 'warn', 'notify() rate limit hit (5/min) — notification dropped');
        return;
      }
      rt.notifyTimes.push(now);
      notify(String(m.title ?? rt.manifest.name).slice(0, 120) || rt.manifest.name, String(m.body ?? '').slice(0, 1000), 'info', '#/evolve');
      appendLog(rt.id, 'info', `notify: ${String(m.title ?? '').slice(0, 120)}`);
      return;
    }
    case 'req': {
      const reply = (msg: CoreToHost) => {
        try {
          if (proc.connected) proc.send(msg);
        } catch {
          /* gone */
        }
      };
      const id = Number(m.id);
      if (m.op === 'secret') {
        const name = String(m.name ?? '');
        if (!(rt.manifest.secrets ?? []).includes(name)) return reply({ t: 'res', id, ok: false, error: `secret "${name}" not declared` });
        reply({ t: 'res', id, ok: true, value: getExtensionSecret(rt.id, name) ?? '' });
      } else reply({ t: 'res', id, ok: false, error: 'unknown request' });
      return;
    }
    default:
      return;
  }
}

export function getExtensionSecret(id: string, name: string): string | undefined {
  const all = (secrets.get() as Record<string, unknown>).extensions as Record<string, Record<string, string>> | undefined;
  return all?.[id]?.[name] || undefined;
}

/** start (or restart) one extension; resolves when it is active or failed */
export async function startExtension(id: string): Promise<{ status: ExtensionStatus; error?: string }> {
  await stopExtension(id, { keepRuntime: true });
  let manifest: ExtensionManifest;
  try {
    manifest = readManifest(id);
  } catch (e) {
    const rt = ensureRuntime(id, { id, name: id, version: '0.0.0', description: '', permissions: [] });
    setStatus(rt, 'error', `cannot read extension.json: ${(e as Error).message}`);
    return statusOf(id);
  }
  const rt = ensureRuntime(id, manifest);
  rt.manifest = manifest;
  rt.registry = null;
  rt.tail = [];
  setStatus(rt, 'starting');
  let host: string;
  try {
    host = await hostScript();
  } catch (e) {
    setStatus(rt, 'error', `extension host unavailable: ${(e as Error).message}`);
    return statusOf(id);
  }
  const { proc, activated } = spawnHost(manifest, host, {
    probe: false,
    onMessage: (m) => onHostMessage(rt, proc, m),
    onLine: (level, text) => {
      if (rt.proc !== proc) return;
      appendLog(id, level, text);
      if (level === 'warn') {
        rt.tail.push(text);
        if (rt.tail.length > 10) rt.tail.shift();
      }
    },
  });
  rt.proc = proc;
  proc.on('exit', (code, signal) => onExit(rt, proc, code, signal));
  const r = await activated;
  if (rt.proc !== proc) return statusOf(id); // superseded by another start/stop
  r.error = withSyntaxLocation(id, r.error);
  if (r.ok && r.registry) {
    rt.registry = r.registry;
    patchState(id, (s) => (s.registry = r.registry));
    registryVersion++;
    setStatus(rt, 'active');
    armJobs(rt);
    appendLog(id, 'info', `activated · ${r.registry.tools.length} tool(s), ${r.registry.panels.length} panel(s), ${r.registry.jobs.length} job(s)`);
  } else {
    setStatus(rt, 'error', r.error);
    appendLog(id, 'error', `activation failed: ${r.error}`);
    activity('EXT', `${manifest.name} failed to activate: ${(r.error ?? '').split('\n')[0].slice(0, 140)}`, 'error');
    rt.proc = null;
    proc.kill('SIGKILL');
  }
  return statusOf(id);
}

function ensureRuntime(id: string, manifest: ExtensionManifest): Runtime {
  let rt = runtimes.get(id);
  if (!rt) {
    rt = {
      id,
      manifest,
      proc: null,
      status: 'starting',
      registry: null,
      pending: new Map(),
      seq: 0,
      crashes: [],
      jobTimers: [],
      restartTimer: null,
      notifyTimes: [],
      tail: [],
    };
    runtimes.set(id, rt);
  }
  return rt;
}

function onExit(rt: Runtime, proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
  if (rt.proc !== proc) return; // intentional stop or superseded
  rt.proc = null;
  clearJobs(rt);
  failPending(rt, `extension process exited (${signal ?? `code ${code}`})`);
  if (rt.status !== 'active') return; // activation failures are handled by startExtension
  rt.registry = null;
  registryVersion++;
  const now = Date.now();
  rt.crashes = [...rt.crashes.filter((t) => now - t < CRASH_WINDOW), now];
  const why = `${signal ?? `exit code ${code}`}${rt.tail.length ? ` — ${rt.tail.slice(-3).join(' | ').slice(0, 400)}` : ''}`;
  appendLog(rt.id, 'error', `crashed (${why})`);
  if (rt.crashes.length > MAX_CRASHES) {
    setStatus(rt, 'error', `crashed ${rt.crashes.length} times in ${CRASH_WINDOW / 60_000} minutes; last: ${why}`);
    activity('EXT', `${rt.manifest.name} keeps crashing — stopped (${why.slice(0, 120)})`, 'error');
    record('extension.error', `${rt.manifest.name} stopped after repeated crashes`, { detail: why, actor: 'system', ref: rt.id });
    return;
  }
  const delay = 1000 * 2 ** (rt.crashes.length - 1);
  setStatus(rt, 'starting', `restarting after crash (${why.slice(0, 200)})`);
  activity('EXT', `${rt.manifest.name} crashed — restarting in ${delay / 1000}s`, 'warn');
  rt.restartTimer = setTimeout(() => {
    rt.restartTimer = null;
    if (getState(rt.id)?.enabled) void startExtension(rt.id);
  }, delay);
  rt.restartTimer.unref?.();
}

function failPending(rt: Runtime, reason: string): void {
  for (const [id, p] of rt.pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    rt.pending.delete(id);
  }
}

export async function stopExtension(id: string, opts: { keepRuntime?: boolean; status?: ExtensionStatus } = {}): Promise<void> {
  const rt = runtimes.get(id);
  if (!rt) return;
  if (rt.restartTimer) {
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
  }
  clearJobs(rt);
  const proc = rt.proc;
  rt.proc = null;
  failPending(rt, 'extension stopped');
  if (rt.registry) registryVersion++;
  rt.registry = null;
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 1500);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        if (proc.connected) proc.disconnect();
      } catch {
        /* ignore */
      }
      proc.kill('SIGTERM');
    });
  }
  if (!opts.keepRuntime) {
    runtimes.delete(id);
    changed('extensions');
  } else if (opts.status) setStatus(rt, opts.status);
}

/** reset the crash counter (user reload / toggle) */
export function resetCrashes(id: string): void {
  const rt = runtimes.get(id);
  if (rt) rt.crashes = [];
}

export async function stopAll(): Promise<void> {
  await Promise.all([...runtimes.keys()].map((id) => stopExtension(id)));
}

/* ─────────────── requests ─────────────── */

function request(
  rt: Runtime,
  msg: Omit<Extract<CoreToHost, { t: 'call' }>, 'id'> | Omit<Extract<CoreToHost, { t: 'panel' }>, 'id'> | Omit<Extract<CoreToHost, { t: 'job' }>, 'id'>,
  timeoutMs: number,
  opts: { onProgress?: (t: string) => void; signal?: AbortSignal } = {},
): Promise<unknown> {
  const proc = rt.proc;
  if (!proc || rt.status !== 'active' || !proc.connected)
    return Promise.reject(new Error(`extension "${rt.id}" is not running (${rt.status}${rt.error ? `: ${rt.error.split('\n')[0]}` : ''})`));
  const id = ++rt.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rt.pending.delete(id);
      try {
        proc.send({ t: 'cancel', id } satisfies CoreToHost);
      } catch {
        /* ignore */
      }
      reject(new Error(`timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    rt.pending.set(id, { resolve, reject, timer, onProgress: opts.onProgress });
    if (opts.signal) {
      const onAbort = () => {
        const p = rt.pending.get(id);
        if (!p) return;
        rt.pending.delete(id);
        clearTimeout(p.timer);
        try {
          proc.send({ t: 'cancel', id } satisfies CoreToHost);
        } catch {
          /* ignore */
        }
        reject(new Error('aborted'));
      };
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      proc.send({ ...msg, id } as CoreToHost);
    } catch (e) {
      rt.pending.delete(id);
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export async function callTool(
  id: string,
  tool: string,
  args: unknown,
  opts: { onProgress?: (t: string) => void; signal?: AbortSignal } = {},
): Promise<unknown> {
  const rt = runtimes.get(id);
  if (!rt) throw new Error(`extension "${id}" is not running`);
  if (rt.registry && !rt.registry.tools.some((t) => t.name === tool))
    throw new Error(`extension "${id}" has no tool "${tool}" (tools: ${rt.registry.tools.map((t) => t.name).join(', ') || 'none'})`);
  patchState(id, (s) => (s.calls = (s.calls ?? 0) + 1));
  try {
    return await request(rt, { t: 'call', tool, args }, CALL_TIMEOUT, opts);
  } catch (e) {
    appendLog(id, 'error', `tool ${tool} failed: ${(e as Error).message.split('\n')[0]}`);
    throw e;
  }
}

export async function renderPanel(id: string, panel: string): Promise<PanelContent> {
  const rt = runtimes.get(id);
  if (!rt) throw new Error(`extension "${id}" is not running`);
  return sanitizePanel(await request(rt, { t: 'panel', panel }, PANEL_TIMEOUT));
}

/* ─────────────── jobs ─────────────── */

function clearJobs(rt: Runtime): void {
  for (const t of rt.jobTimers) clearInterval(t);
  rt.jobTimers = [];
}

function armJobs(rt: Runtime): void {
  clearJobs(rt);
  for (const job of rt.registry?.jobs ?? []) {
    const t = setInterval(() => void runJob(rt.id, job.id), job.everyMinutes * 60_000);
    t.unref?.();
    rt.jobTimers.push(t);
  }
}

const runningJobs = new Set<string>();

export async function runJob(id: string, job: string): Promise<{ ok: boolean; error?: string }> {
  const rt = runtimes.get(id);
  const key = `${id}:${job}`;
  if (!rt || runningJobs.has(key)) return { ok: false, error: 'not running or already in progress' };
  runningJobs.add(key);
  const at = nowIso();
  try {
    await request(rt, { t: 'job', job }, JOB_TIMEOUT);
    patchState(id, (s) => (s.jobs[job] = { lastRunAt: at }));
    return { ok: true };
  } catch (e) {
    const error = (e as Error).message.slice(0, 2000);
    patchState(id, (s) => (s.jobs[job] = { lastRunAt: at, lastError: error }));
    appendLog(id, 'error', `job ${job} failed: ${error.split('\n')[0]}`);
    return { ok: false, error };
  } finally {
    runningJobs.delete(key);
    changed('extensions');
  }
}

/* ─────────────── probe (dry activation) ─────────────── */

/** activate the extension in a throwaway sandboxed process, report its registry/error, exit */
export async function probeExtension(id: string): Promise<{ ok: boolean; registry?: HostRegistry; error?: string; logs: string[] }> {
  const manifest = readManifest(id);
  const host = await hostScript();
  const logs: string[] = [];
  const { proc, activated } = spawnHost(manifest, host, {
    probe: true,
    onMessage: (m) => {
      if (m.t === 'log') logs.push(`[${m.level}] ${String(m.text).slice(0, 500)}`);
    },
    onLine: (level, text) => logs.push(`[${level === 'warn' ? 'stderr' : 'stdout'}] ${text.slice(0, 500)}`),
  });
  const r = await activated;
  if (proc.exitCode === null) proc.kill('SIGKILL');
  r.error = withSyntaxLocation(id, r.error);
  for (const l of logs.slice(-20)) appendLog(id, 'info', `[probe] ${l}`);
  return { ...r, logs: logs.slice(-30) };
}
