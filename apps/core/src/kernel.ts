/**
 * Monarch core "kernel": the small set of shared building blocks every core module uses.
 * OWNED BY THE ORCHESTRATOR — builders may ADD helpers but must not change existing signatures.
 *
 *  - paths            data directory layout (~/.monarch-ai by default, override with MONARCH_HOME)
 *  - JsonStore        tiny atomic JSON-file persistence
 *  - secrets          JSON store for credentials (chmod 600)
 *  - bus              in-process event bus; anything emitted is broadcast to every WS client
 *  - activity()       append to the assistant/activity log (+ broadcast)
 *  - notify()         push a Notification to the UI (+ desktop notify-send best effort)
 *  - ToolDef          engine-neutral tool definition (zod schema) used by BOTH engines
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type {
  ActivityEntry,
  LogTag,
  Notification,
  ServerEvent,
  ToolRisk,
} from '@monarch/shared';

/* ─────────────── paths ─────────────── */

const HOME = process.env.MONARCH_HOME || join(homedir(), '.monarch-ai');

export const paths = {
  home: HOME,
  data: join(HOME, 'data'), // json stores
  sessions: join(HOME, 'sessions'), // one JSON file per chat session
  vault: join(HOME, 'vault'), // default memory vault (overridable in settings.memory.vaultDir)
  secrets: join(HOME, 'secrets.json'),
  logs: join(HOME, 'logs'),
};
for (const p of [paths.home, paths.data, paths.sessions, paths.vault, paths.logs]) mkdirSync(p, { recursive: true });

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

/* ─────────────── JsonStore ─────────────── */

/** Atomic JSON file store. `get()` returns the live in-memory value; call `save()` after mutating, or use `update()`. */
export class JsonStore<T> {
  private value: T;
  private timer: NodeJS.Timeout | null = null;
  constructor(public readonly file: string, defaults: T, private mode?: number) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        this.value = (isPlainObject(defaults) && isPlainObject(raw) ? deepMerge(defaults as any, raw) : raw) as T;
      } catch {
        this.value = structuredClone(defaults);
      }
    } else {
      this.value = structuredClone(defaults);
    }
  }
  get(): T {
    return this.value;
  }
  set(v: T): T {
    this.value = v;
    this.save();
    return v;
  }
  update(fn: (draft: T) => T | void): T {
    const r = fn(this.value);
    if (r !== undefined) this.value = r as T;
    this.save();
    return this.value;
  }
  /** debounced (50ms) atomic write */
  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 50);
  }
  flush(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    renameSync(tmp, this.file);
    if (this.mode) chmodSync(this.file, this.mode);
  }
}

/** create a store in the data dir: dataStore('tasks', []) -> ~/.monarch-ai/data/tasks.json */
export function dataStore<T>(name: string, defaults: T): JsonStore<T> {
  return new JsonStore<T>(join(paths.data, `${name}.json`), defaults);
}

export function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** deep merge: objects merge recursively, arrays and primitives from `patch` replace. */
export function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): T {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/* ─────────────── secrets ─────────────── */

/**
 * Credentials store (~/.monarch-ai/secrets.json, mode 600). Namespaced keys, e.g.
 *   secrets.get().apiKeys['openai']
 *   secrets.get().piOAuth['anthropic']       (pi-ai OAuthCredentials)
 *   secrets.get().google.client / .accounts[accountId]
 *   secrets.get().slack[workspaceId]
 * Never send raw secrets to the UI.
 */
export interface SecretsShape {
  apiKeys: Record<string, string>;
  piOAuth: Record<string, unknown>;
  google: {
    client: { clientId: string; clientSecret: string } | null;
    accounts: Record<string, { refreshToken: string; accessToken?: string; expiresAt?: number; scopes: string[] }>;
  };
  slack: Record<string, { token: string }>;
  [k: string]: unknown;
}
export const secrets = new JsonStore<SecretsShape>(
  paths.secrets,
  { apiKeys: {}, piOAuth: {}, google: { client: null, accounts: {} }, slack: {} },
  0o600,
);

/* ─────────────── event bus ─────────────── */

/** Everything emitted with `broadcast` is sent to all connected WebSocket clients by server.ts. */
class Bus extends EventEmitter {
  broadcast(ev: ServerEvent): void {
    this.emit('server-event', ev);
  }
  onServerEvent(fn: (ev: ServerEvent) => void): () => void {
    this.on('server-event', fn);
    return () => this.off('server-event', fn);
  }
}
export const bus = new Bus();
bus.setMaxListeners(100);

export function changed(collection: Extract<ServerEvent, { type: 'data.changed' }>['collection']): void {
  bus.broadcast({ type: 'data.changed', collection });
}

/* ─────────────── activity log ─────────────── */

const activityStore = dataStore<ActivityEntry[]>('activity', []);
export function activity(tag: LogTag, text: string, level: ActivityEntry['level'] = 'info', sessionId?: string): ActivityEntry {
  const entry: ActivityEntry = { id: newId(), ts: nowIso(), tag, text, level, sessionId };
  activityStore.update((a) => {
    a.unshift(entry);
    if (a.length > 500) a.length = 500;
  });
  bus.broadcast({ type: 'activity', entry });
  return entry;
}
export function recentActivity(limit = 50): ActivityEntry[] {
  return activityStore.get().slice(0, limit);
}

/* ─────────────── notifications ─────────────── */

const notificationStore = dataStore<Notification[]>('notifications', []);
export const notifications = notificationStore;
export function notify(
  title: string,
  body: string,
  level: Notification['level'] = 'info',
  href?: string,
  opts: { desktop?: boolean } = { desktop: true },
): Notification {
  const n: Notification = { id: newId(), ts: nowIso(), title, body, level, href, read: false };
  notificationStore.update((a) => {
    a.unshift(n);
    if (a.length > 200) a.length = 200;
  });
  bus.broadcast({ type: 'notification', notification: n });
  if (opts.desktop) {
    import('node:child_process')
      .then(({ spawn }) => {
        const p = spawn('notify-send', ['-a', 'Monarch', title, body], { stdio: 'ignore' });
        p.on('error', () => {});
      })
      .catch(() => {});
  }
  return n;
}

/* ─────────────── tools (engine-neutral) ─────────────── */

export interface ToolContext {
  sessionId: string;
  /** working directory for this session (coding sessions) */
  cwd: string;
  signal: AbortSignal;
  /** report incremental progress text (shown in the tool card) */
  progress(text: string): void;
}

/**
 * One tool definition, adapted by the engines:
 *  - pi engine:          AgentTool with `parameters = z.toJSONSchema(schema)`
 *  - claude-sdk engine:  in-process MCP tool `mcp__monarch__<name>` with `schema.shape`
 * `run` returns plain text (preferred) or any JSON-able value (stringified by the engine).
 * Throw an Error to signal failure. Risk decides approval (see Settings.permissions.mode).
 */
export interface ToolDef<S extends z.ZodObject<any> = z.ZodObject<any>> {
  name: string; // snake_case, unique
  description: string;
  risk: ToolRisk;
  schema: S;
  /** one-line human summary for approval prompts / activity log */
  summarize?: (input: z.infer<S>) => string;
  /** log tag used for the activity log when the tool runs */
  tag?: LogTag;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown> | unknown;
}

export function defineTool<S extends z.ZodObject<any>>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** stringify a tool result for the model (and truncate for the UI card) */
export function toolResultText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return 'ok';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
export function truncate(s: string, max = 8000): string {
  return s.length > max ? `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]` : s;
}

/* ─────────────── http helpers ─────────────── */

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
