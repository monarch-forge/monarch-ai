/**
 * Extension storage: on-disk layout, metadata state, revision history, logs.
 *
 *   paths.extensions/<id>/extension.json        manifest (ExtensionManifest)
 *   paths.extensions/<id>/index.mjs             ESM source
 *   paths.extensions/<id>/data/                 the extension's private writable dir (store.json lives here)
 *   paths.extensions/<id>/.history/<rev>/       {extension.json, index.mjs, meta.json} — one per write
 *   paths.extensions/.trash/<id>-<ts>/          removed extensions (recoverable by hand)
 *   data/extensions-state.json                  origin / enabled / revision / calls / jobs / last registry
 *   data/extension-logs.json                    last 200 log lines per extension
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ExtensionLogLine,
  ExtensionManifest,
  ExtensionOrigin,
  ExtensionPermission,
  ExtensionRevision,
} from '@monarch/shared';
import { HttpError, nowIso, paths } from '../kernel.ts';
import { serviceStore } from '../services/persist.ts';
import type { HostRegistry } from './ipc.ts';

export const PERMISSIONS: ExtensionPermission[] = ['network', 'shell', 'fs', 'secrets'];
export const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SECRET_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const LOG_CAP = 200;

export interface ExtensionState {
  origin: ExtensionOrigin;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
  calls: number;
  /** last registry reported by the host (shown while the extension is not running) */
  registry?: HostRegistry;
  jobs: Record<string, { lastRunAt?: string; lastError?: string }>;
}

interface StateFile {
  /** builtin examples were seeded once (never re-seeded, even if removed) */
  seeded: boolean;
  items: Record<string, ExtensionState>;
}

export const stateStore = serviceStore<StateFile>('extensions-state', { seeded: false, items: {} });
const logStore = serviceStore<Record<string, ExtensionLogLine[]>>('extension-logs', {});

export const extDir = (id: string): string => join(paths.extensions, id);
export const extDataDir = (id: string): string => join(extDir(id), 'data');
export const extEntry = (id: string): string => join(extDir(id), 'index.mjs');
const historyDir = (id: string): string => join(extDir(id), '.history');

export function getState(id: string): ExtensionState | undefined {
  return stateStore.get().items[id];
}

export function ensureState(id: string, origin: ExtensionOrigin): ExtensionState {
  const items = stateStore.get().items;
  if (!items[id]) {
    const now = nowIso();
    items[id] = { origin, enabled: true, createdAt: now, updatedAt: now, revision: 0, calls: 0, jobs: {} };
    stateStore.save();
  }
  return items[id];
}

export function patchState(id: string, fn: (s: ExtensionState) => void): void {
  const s = stateStore.get().items[id];
  if (!s) return;
  fn(s);
  stateStore.save();
}

/** ids of every extension directory on disk (dot-dirs skipped) */
export function discoverIds(): string[] {
  if (!existsSync(paths.extensions)) return [];
  return readdirSync(paths.extensions, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && ID_RE.test(e.name))
    .filter((e) => existsSync(join(paths.extensions, e.name, 'extension.json')))
    .map((e) => e.name)
    .sort();
}

export function exists(id: string): boolean {
  return existsSync(join(extDir(id), 'extension.json'));
}

/* ─────────────── manifest ─────────────── */

/** validate + normalize a manifest; throws HttpError(400) with a precise message */
export function normalizeManifest(raw: unknown, id?: string): ExtensionManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'manifest must be an object');
  const m = raw as Record<string, unknown>;
  const mid = String(m.id ?? id ?? '').trim();
  if (!ID_RE.test(mid) || mid.length > 40) throw new HttpError(400, `manifest.id "${mid}" must be kebab-case (e.g. "hacker-news"), max 40 chars`);
  if (id && mid !== id) throw new HttpError(400, `manifest.id "${mid}" does not match the extension id "${id}"`);
  const name = String(m.name ?? '').trim();
  if (!name || name.length > 60) throw new HttpError(400, 'manifest.name is required (max 60 chars)');
  const description = String(m.description ?? '').trim();
  if (!description) throw new HttpError(400, 'manifest.description is required');
  const version = String(m.version ?? '0.1.0').trim() || '0.1.0';
  if (!/^\d+\.\d+\.\d+([-.+][\w.-]+)?$/.test(version)) throw new HttpError(400, `manifest.version "${version}" must be semver-ish ("0.1.0")`);
  const permsIn = m.permissions ?? [];
  if (!Array.isArray(permsIn)) throw new HttpError(400, 'manifest.permissions must be an array');
  const permissions: ExtensionPermission[] = [];
  for (const p of permsIn) {
    if (!PERMISSIONS.includes(p as ExtensionPermission))
      throw new HttpError(400, `unknown permission "${p}" — allowed: ${PERMISSIONS.join(', ')}`);
    if (!permissions.includes(p as ExtensionPermission)) permissions.push(p as ExtensionPermission);
  }
  const secretsIn = m.secrets ?? [];
  if (!Array.isArray(secretsIn)) throw new HttpError(400, 'manifest.secrets must be an array of names');
  const secrets: string[] = [];
  for (const s of secretsIn) {
    if (typeof s !== 'string' || !SECRET_RE.test(s)) throw new HttpError(400, `secret name "${s}" must match ${SECRET_RE}`);
    if (!secrets.includes(s)) secrets.push(s);
  }
  if (secrets.length && !permissions.includes('secrets')) permissions.push('secrets');
  return { id: mid, name: name.slice(0, 60), version, description: description.slice(0, 500), permissions, ...(secrets.length ? { secrets } : {}) };
}

export function validateSource(source: unknown): string {
  if (typeof source !== 'string' || !source.trim()) throw new HttpError(400, 'source (index.mjs) is required');
  if (source.length > 512_000) throw new HttpError(400, 'source is too large (max 500 KB)');
  if (!/export\s+default\b/.test(source))
    throw new HttpError(400, 'source must `export default function activate(api) { ... }` (no `export default` found)');
  return source;
}

export function readManifest(id: string): ExtensionManifest {
  return JSON.parse(readFileSync(join(extDir(id), 'extension.json'), 'utf8')) as ExtensionManifest;
}

export function readSource(id: string): string {
  try {
    return readFileSync(extEntry(id), 'utf8');
  } catch {
    return '';
  }
}

/* ─────────────── writes + history ─────────────── */

export interface RevisionMeta extends ExtensionRevision {}

/** write manifest+source as a new revision (also snapshotted into .history/<rev>/) */
export function writeRevision(
  manifest: ExtensionManifest,
  source: string,
  meta: { actor: ExtensionRevision['actor']; note: string; origin: ExtensionOrigin },
): ExtensionState {
  const id = manifest.id;
  const dir = extDir(id);
  mkdirSync(join(dir, 'data'), { recursive: true });
  const st = ensureState(id, meta.origin);
  const revision = Math.max(st.revision, lastHistoryRevision(id)) + 1;
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  writeAtomic(join(dir, 'extension.json'), manifestJson);
  writeAtomic(join(dir, 'index.mjs'), source);
  const h = join(historyDir(id), String(revision));
  mkdirSync(h, { recursive: true });
  writeFileSync(join(h, 'extension.json'), manifestJson);
  writeFileSync(join(h, 'index.mjs'), source);
  const rm: RevisionMeta = { revision, ts: nowIso(), actor: meta.actor, note: meta.note.slice(0, 500) };
  writeFileSync(join(h, 'meta.json'), JSON.stringify(rm, null, 2));
  st.revision = revision;
  st.updatedAt = rm.ts;
  stateStore.save();
  return st;
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function lastHistoryRevision(id: string): number {
  const d = historyDir(id);
  if (!existsSync(d)) return 0;
  return readdirSync(d)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .reduce((a, b) => Math.max(a, b), 0);
}

export function listHistory(id: string): ExtensionRevision[] {
  const d = historyDir(id);
  if (!existsSync(d)) return [];
  const out: ExtensionRevision[] = [];
  for (const name of readdirSync(d)) {
    const n = Number(name);
    if (!Number.isInteger(n)) continue;
    try {
      out.push(JSON.parse(readFileSync(join(d, name, 'meta.json'), 'utf8')));
    } catch {
      out.push({ revision: n, ts: nowIso(), actor: 'system', note: '(no metadata)' });
    }
  }
  return out.sort((a, b) => b.revision - a.revision);
}

export function readRevision(id: string, revision: number): { manifest: ExtensionManifest; source: string } {
  const h = join(historyDir(id), String(revision));
  if (!existsSync(join(h, 'index.mjs'))) throw new HttpError(404, `revision ${revision} of "${id}" not found`);
  return {
    manifest: JSON.parse(readFileSync(join(h, 'extension.json'), 'utf8')),
    source: readFileSync(join(h, 'index.mjs'), 'utf8'),
  };
}

/** move the extension dir to .trash and forget its state/logs */
export function removeFromDisk(id: string): void {
  const dir = extDir(id);
  if (existsSync(dir)) {
    const trash = join(paths.extensions, '.trash');
    mkdirSync(trash, { recursive: true });
    const dest = join(trash, `${id}-${Date.now()}`);
    try {
      renameSync(dir, dest);
    } catch {
      cpSync(dir, dest, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }
  delete stateStore.get().items[id];
  stateStore.save();
  delete logStore.get()[id];
  logStore.save();
}

/* ─────────────── logs ─────────────── */

export function appendLog(id: string, level: ExtensionLogLine['level'], text: string): ExtensionLogLine {
  const line: ExtensionLogLine = { ts: nowIso(), level, text: text.slice(0, 2000) };
  const all = logStore.get();
  const arr = (all[id] ??= []);
  arr.push(line);
  if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
  logStore.save();
  return line;
}

export function getLogs(id: string, limit = LOG_CAP): ExtensionLogLine[] {
  const arr = logStore.get()[id] ?? [];
  return arr.slice(-limit);
}
