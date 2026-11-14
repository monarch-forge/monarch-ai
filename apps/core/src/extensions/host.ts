/**
 * Extension host — runs ONE extension inside its own sandboxed Node child process.
 *
 * Spawned by manager.ts with the Node permission model (--permission + narrow --allow-fs-* flags,
 * --allow-net only with the 'network' permission, --allow-child-process only with 'shell').
 * Bundled to a single self-contained file (dist/extension-host.mjs, zod inlined) so it needs no
 * node_modules access at runtime.
 *
 * Lifecycle: read boot info from env → import index.mjs → await default export activate(api) →
 * send {t:'ready', registry} → serve call/panel/job requests over IPC until the core disconnects.
 */
import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CoreToHost, HostBoot, HostRegistry, HostToCore, HostToolInfo } from './ipc.ts';

type Risk = 'safe' | 'sensitive' | 'dangerous';

interface ToolSpec {
  name: string;
  description: string;
  risk: Risk;
  schema: z.ZodObject<any>;
  run: (input: any, ctx: ToolRunContext) => unknown;
}
interface ToolRunContext {
  signal: AbortSignal;
  progress(text: string): void;
}
interface PanelSpec {
  id: string;
  title: string;
  render: () => unknown;
}
interface JobSpec {
  id: string;
  everyMinutes: number;
  run: () => unknown;
}

const boot: HostBoot = JSON.parse(process.env.MONARCH_EXT_BOOT || '{}');
const perms = new Set(boot.permissions ?? []);

const send = (msg: HostToCore): void => {
  try {
    if (process.connected) process.send!(msg);
  } catch {
    /* core went away */
  }
};

const fmt = (args: unknown[]): string =>
  args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ')
    .slice(0, 4000);

const errText = (e: unknown): string => (e instanceof Error ? e.message || String(e) : String(e));
/** error with a short stack (keeps file:line of the extension, drops host internals) */
const errStack = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const lines = (e.stack || `${e.name}: ${e.message}`).split('\n');
  const keep = lines.filter((l, i) => i === 0 || !/extension-host|node:internal|node:events|process\.emit/.test(l)).slice(0, 8);
  // file:///…/<id>/index.mjs?v=123:6:11 → index.mjs:6:11
  return keep.join('\n').replace(/file:\/\/[^\s)]*?\/index\.mjs(?:\?v=\d+)?/g, 'index.mjs');
};

/* ─────────────── registry ─────────────── */

const tools = new Map<string, ToolSpec>();
const panels = new Map<string, PanelSpec>();
const jobs = new Map<string, JobSpec>();
let activated = false;

const NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
const ID_RE = /^[a-z][a-z0-9_-]{0,47}$/;

function registry(): HostRegistry {
  const t: HostToolInfo[] = [];
  for (const spec of tools.values()) {
    let schema: Record<string, unknown>;
    try {
      schema = z.toJSONSchema(spec.schema, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
      delete schema.$schema;
    } catch {
      schema = { type: 'object', properties: {} };
    }
    t.push({ name: spec.name, description: spec.description, risk: spec.risk, schema });
  }
  return {
    tools: t,
    panels: [...panels.values()].map((p) => ({ id: p.id, title: p.title })),
    jobs: [...jobs.values()].map((j) => ({ id: j.id, everyMinutes: j.everyMinutes })),
  };
}

let regTimer: NodeJS.Timeout | null = null;
function registryChanged(): void {
  if (!activated || regTimer) return;
  regTimer = setTimeout(() => {
    regTimer = null;
    send({ t: 'registry', registry: registry() });
  }, 20);
}

/* ─────────────── store (tiny JSON kv in the data dir) ─────────────── */

const storeFile = join(boot.dataDir, 'store.json');
let storeCache: Record<string, unknown> | null = null;
function storeLoad(): Record<string, unknown> {
  if (storeCache) return storeCache;
  try {
    storeCache = existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')) : {};
  } catch {
    storeCache = {};
  }
  if (!storeCache || typeof storeCache !== 'object' || Array.isArray(storeCache)) storeCache = {};
  return storeCache;
}
function storeSave(): void {
  mkdirSync(boot.dataDir, { recursive: true });
  const tmp = `${storeFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(storeCache ?? {}, null, 2));
  renameSync(tmp, storeFile);
}

/* ─────────────── requests to the core ─────────────── */

let reqSeq = 0;
const pendingReq = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function request(op: 'secret', name: string): Promise<unknown> {
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    pendingReq.set(id, { resolve, reject });
    send({ t: 'req', id, op, name });
    setTimeout(() => {
      if (pendingReq.delete(id)) reject(new Error(`core did not answer ${op} request`));
    }, 10_000).unref();
  });
}

/* ─────────────── the api object ─────────────── */

const log = {
  info: (...a: unknown[]) => send({ t: 'log', level: 'info', text: fmt(a) }),
  warn: (...a: unknown[]) => send({ t: 'log', level: 'warn', text: fmt(a) }),
  error: (...a: unknown[]) => send({ t: 'log', level: 'error', text: fmt(a) }),
};

const nativeFetch = globalThis.fetch;
const guardedFetch: typeof fetch = perms.has('network')
  ? nativeFetch.bind(globalThis)
  : async () => {
      throw new Error(`extension "${boot.id}" has no 'network' permission — add it to the manifest to use fetch`);
    };
// soft guard; the Node permission model (when it supports --allow-net) is the real enforcement
globalThis.fetch = guardedFetch;

const api = Object.freeze({
  z,
  manifest: Object.freeze({
    id: boot.id,
    name: boot.name,
    version: boot.version,
    description: boot.description,
    permissions: [...perms],
    secrets: [...(boot.secrets ?? [])],
  }),
  dataDir: boot.dataDir,
  log,
  fetch: guardedFetch,

  tool(def: {
    name: string;
    description: string;
    risk?: Risk;
    input?: z.ZodObject<any> | Record<string, z.ZodType>;
    run: (input: any, ctx: ToolRunContext) => unknown;
  }): void {
    if (!def || typeof def !== 'object') throw new TypeError('api.tool(def): def must be an object');
    if (typeof def.name !== 'string' || !NAME_RE.test(def.name))
      throw new TypeError(`api.tool: name "${def?.name}" must be snake_case (a-z, 0-9, _), max 48 chars`);
    if (typeof def.description !== 'string' || !def.description.trim())
      throw new TypeError(`api.tool(${def.name}): description is required`);
    if (typeof def.run !== 'function') throw new TypeError(`api.tool(${def.name}): run must be a function`);
    const risk: Risk = def.risk ?? 'sensitive';
    if (!['safe', 'sensitive', 'dangerous'].includes(risk))
      throw new TypeError(`api.tool(${def.name}): risk must be 'safe' | 'sensitive' | 'dangerous'`);
    let schema: z.ZodObject<any>;
    if (def.input === undefined) schema = z.object({});
    else if (def.input instanceof z.ZodObject) schema = def.input;
    else if (def.input && typeof def.input === 'object' && !(def.input instanceof z.ZodType)) schema = z.object(def.input as any);
    else throw new TypeError(`api.tool(${def.name}): input must be z.object({...}) (or a plain shape of zod types)`);
    if (tools.has(def.name)) throw new Error(`api.tool: duplicate tool name "${def.name}"`);
    tools.set(def.name, { name: def.name, description: def.description.trim().slice(0, 1000), risk, schema, run: def.run });
    registryChanged();
  },

  panel(def: { id: string; title: string; render: () => unknown }): void {
    if (!def || typeof def.id !== 'string' || !ID_RE.test(def.id)) throw new TypeError(`api.panel: id "${def?.id}" must be kebab/snake case`);
    if (typeof def.title !== 'string' || !def.title.trim()) throw new TypeError(`api.panel(${def.id}): title is required`);
    if (typeof def.render !== 'function') throw new TypeError(`api.panel(${def.id}): render must be a function`);
    if (panels.has(def.id)) throw new Error(`api.panel: duplicate panel id "${def.id}"`);
    panels.set(def.id, { id: def.id, title: def.title.trim().slice(0, 80), render: def.render });
    registryChanged();
  },

  job(def: { id: string; everyMinutes: number; run: () => unknown }): void {
    if (!def || typeof def.id !== 'string' || !ID_RE.test(def.id)) throw new TypeError(`api.job: id "${def?.id}" must be kebab/snake case`);
    const every = Number(def.everyMinutes);
    if (!Number.isFinite(every) || every < 1) throw new TypeError(`api.job(${def.id}): everyMinutes must be >= 1`);
    if (typeof def.run !== 'function') throw new TypeError(`api.job(${def.id}): run must be a function`);
    if (jobs.has(def.id)) throw new Error(`api.job: duplicate job id "${def.id}"`);
    jobs.set(def.id, { id: def.id, everyMinutes: Math.round(every), run: def.run });
    registryChanged();
  },

  store: Object.freeze({
    get<T = unknown>(key: string, fallback?: T): T | undefined {
      const v = storeLoad()[key];
      return (v === undefined ? fallback : structuredClone(v)) as T | undefined;
    },
    set(key: string, value: unknown): void {
      if (value === undefined) {
        delete storeLoad()[key];
      } else {
        storeLoad()[key] = JSON.parse(JSON.stringify(value));
      }
      storeSave();
    },
    delete(key: string): void {
      delete storeLoad()[key];
      storeSave();
    },
    all(): Record<string, unknown> {
      return structuredClone(storeLoad());
    },
  }),

  secrets: Object.freeze({
    async get(name: string): Promise<string | undefined> {
      if (!(boot.secrets ?? []).includes(name))
        throw new Error(`secret "${name}" is not declared in the manifest's "secrets" list`);
      const v = await request('secret', name);
      return typeof v === 'string' && v ? v : undefined;
    },
  }),

  notify(title: string, body = ''): void {
    send({ t: 'notify', title: String(title ?? '').slice(0, 120), body: String(body ?? '').slice(0, 1000) });
  },
});

/* ─────────────── serving requests ─────────────── */

const running = new Map<number, AbortController>();

function resultOf(v: unknown): unknown {
  if (v === undefined || v === null) return 'ok';
  if (typeof v === 'string') return v.length > 200_000 ? `${v.slice(0, 200_000)}\n… [truncated]` : v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

async function handle(msg: CoreToHost): Promise<void> {
  switch (msg.t) {
    case 'res': {
      const p = pendingReq.get(msg.id);
      if (!p) return;
      pendingReq.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error || 'request failed'));
      return;
    }
    case 'cancel':
      running.get(msg.id)?.abort();
      return;
    case 'call': {
      const spec = tools.get(msg.tool);
      if (!spec) return send({ t: 'result', id: msg.id, ok: false, error: `unknown tool "${msg.tool}"` });
      const parsed = spec.schema.safeParse(msg.args ?? {});
      if (!parsed.success)
        return send({ t: 'result', id: msg.id, ok: false, error: `invalid input:\n${z.prettifyError(parsed.error)}` });
      const ac = new AbortController();
      running.set(msg.id, ac);
      try {
        const out = await spec.run(parsed.data, {
          signal: ac.signal,
          progress: (text: string) => send({ t: 'progress', id: msg.id, text: String(text).slice(0, 2000) }),
        });
        send({ t: 'result', id: msg.id, ok: true, output: resultOf(out) });
      } catch (e) {
        send({ t: 'result', id: msg.id, ok: false, error: errStack(e) });
      } finally {
        running.delete(msg.id);
      }
      return;
    }
    case 'panel': {
      const spec = panels.get(msg.panel);
      if (!spec) return send({ t: 'result', id: msg.id, ok: false, error: `unknown panel "${msg.panel}"` });
      try {
        send({ t: 'result', id: msg.id, ok: true, output: resultOf(await spec.render()) });
      } catch (e) {
        send({ t: 'result', id: msg.id, ok: false, error: errStack(e) });
      }
      return;
    }
    case 'job': {
      const spec = jobs.get(msg.job);
      if (!spec) return send({ t: 'result', id: msg.id, ok: false, error: `unknown job "${msg.job}"` });
      try {
        await spec.run();
        send({ t: 'result', id: msg.id, ok: true, output: 'ok' });
      } catch (e) {
        send({ t: 'result', id: msg.id, ok: false, error: errStack(e) });
      }
      return;
    }
  }
}

/* ─────────────── boot ─────────────── */

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  void handle(m as CoreToHost).catch((e) => log.error('host error:', errText(e)));
});
process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (e) => {
  if (!activated) {
    send({ t: 'fatal', error: errStack(e) });
    setTimeout(() => process.exit(1), 50);
    return;
  }
  log.error('uncaught exception:', errStack(e));
});
process.on('unhandledRejection', (e) => log.error('unhandled rejection:', errStack(e)));

// console.* goes to stdout/stderr, which the core captures into the extension log
async function main(): Promise<void> {
  try {
    if (!boot.entry) throw new Error('host started without boot info');
    mkdirSync(boot.dataDir, { recursive: true });
    const mod = await import(`${pathToFileURL(boot.entry).href}?v=${Date.now()}`);
    const activate = mod?.default;
    if (typeof activate !== 'function')
      throw new Error('index.mjs must `export default function activate(api) { ... }` (no default export function found)');
    await activate(api);
    activated = true;
    send({ t: 'ready', registry: registry() });
    if (boot.probe) setTimeout(() => process.exit(0), 50);
  } catch (e) {
    send({ t: 'fatal', error: errStack(e) });
    setTimeout(() => process.exit(1), 50);
  }
}

void main();
