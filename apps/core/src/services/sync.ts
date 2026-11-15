/**
 * Encrypted sync of the whole Monarch data dir to a PRIVATE git remote (GitHub via `gh`, GitLab via
 * `glab`, or any git remote with the user's own credentials). See protocol.ts "sync".
 *
 * Bundle (plaintext, deterministic): "MONARCHBUNDLE\x01" | u32be manifestLen | manifest JSON | file bytes…
 *   manifest = { format: 1, home: <source data dir>, files: [{ p: relPath (posix), s: size, m: mode }] } sorted by p.
 *   Excluded: logs/, cache/, sync-repo/, backups/, extensions/.trash, node_modules, *.tmp, data/sync-state.json.
 *   Stripped: settings.json → `sync` block (device-local), secrets.json → `sync` (the passphrase).
 * contentHash = sha256 over (path, size, bytes) of every entry EXCEPT volatile ones (activity, notifications,
 *   usage, extension logs) so that merely running the app doesn't create commits.
 * Encryption: gzip → AES-256-GCM, key = scrypt(passphrase, salt16, N=2^17 r=8 p=1), iv12.
 *   file = "MONARCHSYNC" | u8 version(1) | u32be headerLen | header JSON {kdf,N,r,p,salt,iv,tag} | ciphertext
 * Repo contents: monarch.bundle.enc + snapshot.json (SyncSnapshotMeta, no secrets).
 *
 * Device-local (never overwritten by a pull): settings.sync, secrets.sync (passphrase), data/sync-state.json,
 *   settings.claudeSdk.executablePath, coding.defaultWorkspace if the incoming path doesn't exist here
 *   (workspaces: incoming ones that exist here ∪ local ones), memory.vaultDir (rebased onto this data dir when
 *   it was inside the source's data dir; kept local when the incoming path doesn't exist here).
 *
 * Tokens: read from `gh auth token` / `glab config get token` stdout, passed to git ONLY through
 *   GIT_CONFIG_COUNT/KEY/VALUE env (http.<origin>/.extraheader); scrubbed from every error message.
 */
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Settings, SyncAccount, SyncProviders, SyncSettings, SyncSnapshot, SyncSnapshotMeta, SyncStatus } from '@monarch/shared';
import { activity, changed, HttpError, isPlainObject, notify, nowIso, paths, secrets } from '../kernel.ts';
import { getSettings, onSettingsChanged } from '../settings.ts';
import { flushAll } from './persist.ts';
import { CORE_VERSION } from './meta.ts';

/* ─────────────── constants / state ─────────────── */

export const RESTART_EXIT_CODE = 75;
const REPO_DIR = join(paths.home, 'sync-repo');
const BACKUP_DIR = join(paths.home, 'backups');
const STATE_FILE = join(paths.data, 'sync-state.json');
const BUNDLE_FILE = 'monarch.bundle.enc';
const META_FILE = 'snapshot.json';
const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const EXCLUDE_TOP = new Set(['logs', 'cache', 'sync-repo', 'backups']);
const EXCLUDE_EXACT = new Set(['extensions/.trash', 'data/sync-state.json']);
const VOLATILE = new Set(['data/activity.json', 'data/notifications.json', 'data/usage.json', 'data/extension-logs.json']);
const KEEP_BACKUPS = 5;

interface SyncState {
  lastPushAt?: string;
  lastPullAt?: string;
  /** remote commit we last pushed or pulled (our base) */
  baseCommit?: string;
  /** contentHash of our base */
  baseHash?: string;
  remote?: SyncSnapshot;
  remoteReady?: boolean;
  error?: string;
  /** set by a pull: recompute baseHash from disk on next start (restored files merged with device-local fields) */
  rebase?: boolean;
}

function loadState(): SyncState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SyncState;
  } catch {
    return {};
  }
}
let state: SyncState = loadState();
function saveState(patch: Partial<SyncState>): void {
  state = { ...state, ...patch };
  for (const k of Object.keys(state) as (keyof SyncState)[]) if (state[k] === undefined) delete state[k];
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let busy: SyncStatus['busy'];
let queue: Promise<unknown> = Promise.resolve();
/**
 * serialize every operation (one at a time). `quiet` operations (read-only, e.g. history) neither show as
 * busy nor broadcast changed('sync') — the UI reloads history on every 'sync' event, so a broadcasting
 * history read would re-trigger itself forever and keep the status permanently "busy".
 */
function serial<T>(kind: NonNullable<SyncStatus['busy']>, fn: () => Promise<T>, opts: { quiet?: boolean } = {}): Promise<T> {
  if (opts.quiet) {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  }
  const run = async (): Promise<T> => {
    busy = kind;
    changed('sync');
    try {
      const r = await fn();
      if (isPlainObject(r) && 'localChanged' in r) delete (r as unknown as SyncStatus).busy;
      return r;
    } finally {
      busy = undefined;
      changed('sync');
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

const cfg = (): SyncSettings => getSettings().sync;
const deviceName = (): string => cfg().deviceName?.trim() || hostname();

/* ─────────────── secret scrubbing / process helpers ─────────────── */

const sensitive = new Set<string>();
function addSensitive(token: string): void {
  if (!token) return;
  sensitive.add(token);
  sensitive.add(Buffer.from(`x-access-token:${token}`).toString('base64'));
  sensitive.add(Buffer.from(`oauth2:${token}`).toString('base64'));
}
export function scrub(s: string): string {
  let out = s;
  for (const t of sensitive) if (t.length >= 6) out = out.split(t).join('***');
  const pass = (secrets.get() as any).sync?.passphrase;
  if (typeof pass === 'string' && pass.length >= 4) out = out.split(pass).join('***');
  // generic patterns (gh/glab tokens, basic auth headers, creds in URLs)
  return out
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g, '***')
    .replace(/(Authorization:\s*(Basic|Bearer)\s+)\S+/gi, '$1***')
    .replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@');
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((res) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      res({ code: -1, stdout: '', stderr: String(e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      res({ code: -1, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code: code ?? -1, stdout, stderr });
    });
  });
}

/* ─────────────── detection ─────────────── */

async function version(bin: string): Promise<{ installed: boolean; version?: string }> {
  const r = await run(bin, ['--version'], { timeoutMs: 10_000 });
  if (r.code !== 0) return { installed: false };
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout);
  return { installed: true, version: m?.[1] };
}

export async function detectProviders(): Promise<SyncProviders> {
  const [git, gh, glab] = await Promise.all([version('git'), version('gh'), version('glab')]);
  const accounts: SyncAccount[] = [];
  if (gh.installed) {
    const r = await run('gh', ['auth', 'status', '--json', 'hosts'], { timeoutMs: 15_000 });
    try {
      const hosts = JSON.parse(r.stdout).hosts as Record<string, { state: string; active: boolean; host: string; login: string; scopes?: string }[]>;
      for (const [host, list] of Object.entries(hosts ?? {}))
        for (const a of list ?? [])
          if (a.state === 'success' && a.login) accounts.push({ provider: 'github', host: a.host || host, login: a.login, active: !!a.active, scopes: a.scopes });
    } catch {
      /* older gh without --json: ignore */
    }
  }
  if (glab.installed) {
    const r = await run('glab', ['auth', 'status'], { timeoutMs: 15_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    for (const m of text.matchAll(/Logged in to (\S+) as (\S+)/g)) {
      const host = m[1]!;
      const login = m[2]!.replace(/[()]/g, '');
      if (!accounts.some((a) => a.provider === 'gitlab' && a.host === host && a.login === login))
        accounts.push({ provider: 'gitlab', host, login, active: true });
    }
  }
  return { git, gh, glab, accounts };
}

/* ─────────────── auth / remote ─────────────── */

interface Remote {
  url: string; // never contains a token
  display: string;
  env: Record<string, string>;
  token?: string;
}

async function providerToken(s: SyncSettings): Promise<string> {
  if (s.provider === 'github') {
    const args = ['auth', 'token', '--hostname', s.host || 'github.com'];
    if (s.account) args.push('--user', s.account);
    const r = await run('gh', args, { timeoutMs: 15_000 });
    const t = r.stdout.trim();
    if (r.code !== 0 || !t) throw new HttpError(401, `No GitHub token for ${s.account || 'the active account'}@${s.host} — run \`gh auth login\``);
    addSensitive(t);
    return t;
  }
  const r = await run('glab', ['config', 'get', 'token', '--host', s.host || 'gitlab.com'], { timeoutMs: 15_000 });
  let t = r.stdout.trim();
  if (r.code !== 0 || !t) {
    const r2 = await run('glab', ['auth', 'token', '--hostname', s.host || 'gitlab.com'], { timeoutMs: 15_000 }); // newer glab
    t = r2.stdout.trim();
  }
  if (!t) throw new HttpError(401, `No GitLab token for ${s.host} — run \`glab auth login\``);
  addSensitive(t);
  return t;
}

function gitEnv(extra: [string, string][] = []): Record<string, string> {
  const pairs: [string, string][] = [['credential.helper', ''], ...extra];
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

function repoName(s: SyncSettings): string {
  const r = s.repo.trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  return r || (s.account ? `${s.account}/monarch-sync` : '');
}

async function resolveRemote(s: SyncSettings): Promise<Remote> {
  if (s.provider === 'git') {
    if (!s.remoteUrl.trim()) throw new HttpError(400, 'Set a remote URL for the git provider');
    // user's own creds (ssh agent / credential helper); never prompt
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
    return { url: s.remoteUrl.trim(), display: scrub(s.remoteUrl.trim()), env };
  }
  const repo = repoName(s);
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) throw new HttpError(400, `Invalid repo "${repo}" (expected owner/name)`);
  const host = s.host || (s.provider === 'github' ? 'github.com' : 'gitlab.com');
  const token = await providerToken(s);
  const basic = Buffer.from(`${s.provider === 'github' ? 'x-access-token' : 'oauth2'}:${token}`).toString('base64');
  const url = `https://${host}/${repo}.git`;
  return { url, display: url, token, env: gitEnv([[`http.https://${host}/.extraheader`, `Authorization: Basic ${basic}`]]) };
}

async function api(s: SyncSettings, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const host = s.host || (s.provider === 'github' ? 'github.com' : 'gitlab.com');
  const base =
    s.provider === 'github' ? (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`) : `https://${host}/api/v4`;
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'user-agent': 'monarch-sync', accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  try {
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.slice(0, 200) };
    }
    return { status: r.status, json };
  } catch (e) {
    throw new HttpError(502, `${s.provider} API unreachable: ${scrub(e instanceof Error ? e.message : String(e))}`);
  }
}

/** make sure the provider repo exists and is PRIVATE (creates it private if missing). Hard error if public. */
async function ensureProviderRepo(s: SyncSettings, token: string): Promise<void> {
  const repo = repoName(s);
  const [owner, ...rest] = repo.split('/');
  const name = rest.join('/');
  if (s.provider === 'github') {
    let r = await api(s, token, 'GET', `/repos/${repo}`);
    if (r.status === 404) {
      const user = await api(s, token, 'GET', '/user');
      const path = user.json?.login?.toLowerCase() === owner!.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`;
      const c = await api(s, token, 'POST', path, { name, private: true, auto_init: false, description: 'Monarch sync (private)' });
      if (c.status >= 300) throw new HttpError(502, `Could not create ${repo}: ${scrub(c.json?.message ?? String(c.status))}`);
      activity('SYS', `Sync: created private repo ${repo}`);
      r = await api(s, token, 'GET', `/repos/${repo}`);
    }
    if (r.status >= 300) throw new HttpError(r.status === 401 ? 401 : 502, `GitHub: ${scrub(r.json?.message ?? String(r.status))} (${repo})`);
    if (r.json?.private !== true || r.json?.visibility === 'public')
      throw new HttpError(409, `Refusing to sync: ${repo} is PUBLIC. Make it private or choose another repo.`);
    return;
  }
  // gitlab
  let r = await api(s, token, 'GET', `/projects/${encodeURIComponent(repo)}`);
  if (r.status === 404) {
    const user = await api(s, token, 'GET', '/user');
    const body: Record<string, unknown> = { name: name.split('/').pop(), path: name.split('/').pop(), visibility: 'private' };
    if (user.json?.username?.toLowerCase() !== owner!.toLowerCase() || rest.length > 1) {
      const ns = await api(s, token, 'GET', `/namespaces/${encodeURIComponent(repo.split('/').slice(0, -1).join('/'))}`);
      if (ns.status >= 300) throw new HttpError(502, `GitLab namespace not found for ${repo}`);
      body.namespace_id = ns.json.id;
    }
    const c = await api(s, token, 'POST', '/projects', body);
    if (c.status >= 300) throw new HttpError(502, `Could not create ${repo}: ${scrub(JSON.stringify(c.json?.message ?? c.status))}`);
    activity('SYS', `Sync: created private project ${repo}`);
    r = await api(s, token, 'GET', `/projects/${encodeURIComponent(repo)}`);
  }
  if (r.status >= 300) throw new HttpError(r.status === 401 ? 401 : 502, `GitLab: ${scrub(JSON.stringify(r.json?.message ?? r.status))} (${repo})`);
  if (r.json?.visibility !== 'private') throw new HttpError(409, `Refusing to sync: ${repo} is ${r.json?.visibility ?? 'not private'}. Make it private.`);
}

/* ─────────────── git working clone ─────────────── */

async function git(args: string[], remote: Remote, allowFail = false): Promise<RunResult> {
  const r = await run('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd: REPO_DIR, env: remote.env, timeoutMs: 180_000 });
  if (r.code !== 0 && !allowFail) throw new HttpError(502, `git ${args[0]} failed: ${scrub((r.stderr || r.stdout).trim()).slice(0, 500)}`);
  return r;
}

async function ensureRepoDir(remote: Remote): Promise<void> {
  mkdirSync(REPO_DIR, { recursive: true });
  if (!existsSync(join(REPO_DIR, '.git'))) await git(['init', '-q'], remote);
  const cur = await git(['remote', 'get-url', 'origin'], remote, true);
  if (cur.code !== 0) await git(['remote', 'add', 'origin', remote.url], remote);
  else if (cur.stdout.trim() !== remote.url) await git(['remote', 'set-url', 'origin', remote.url], remote);
}

/** fetch the branch; returns the remote tip commit (undefined when the remote branch doesn't exist) */
async function fetchRemote(remote: Remote): Promise<string | undefined> {
  const b = cfg().branch || 'main';
  const ls = await git(['ls-remote', '--heads', 'origin', `refs/heads/${b}`], remote);
  if (!ls.stdout.trim()) return undefined;
  await git(['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${b}:refs/remotes/origin/${b}`], remote);
  const r = await git(['rev-parse', `refs/remotes/origin/${b}`], remote);
  return r.stdout.trim();
}

async function readMetaAt(remote: Remote, commit: string): Promise<SyncSnapshot | undefined> {
  const r = await git(['show', `${commit}:${META_FILE}`], remote, true);
  if (r.code !== 0) return undefined;
  const msg = await git(['log', '-1', '--format=%s', commit], remote, true);
  try {
    return { ...(JSON.parse(r.stdout) as SyncSnapshotMeta), commit, message: msg.stdout.trim() };
  } catch {
    return undefined;
  }
}

async function readBundleAt(remote: Remote, commit: string): Promise<Buffer> {
  const r = await new Promise<Buffer>((res, rej) => {
    const ch = spawn('git', ['show', `${commit}:${BUNDLE_FILE}`], { cwd: REPO_DIR, env: { ...process.env, ...remote.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    ch.stdout.on('data', (d: Buffer) => chunks.push(d));
    ch.stderr.on('data', (d) => (err += d));
    ch.on('error', rej);
    ch.on('close', (code) => (code === 0 ? res(Buffer.concat(chunks)) : rej(new HttpError(404, `No bundle in ${commit.slice(0, 8)}: ${scrub(err.trim())}`))));
  });
  return r;
}

/* ─────────────── bundle ─────────────── */

interface Entry {
  p: string;
  s: number;
  m: number;
}
interface Bundle {
  entries: { e: Entry; data: Buffer }[];
  home: string;
}

function excluded(rel: string, isDir: boolean): boolean {
  const parts = rel.split('/');
  if (parts.length && EXCLUDE_TOP.has(parts[0]!)) return true;
  if (EXCLUDE_EXACT.has(rel)) return true;
  if (parts.includes('node_modules') || parts.includes('.git')) return true;
  if (!isDir && (rel.endsWith('.tmp') || rel.endsWith('.lock'))) return true;
  return false;
}

function walk(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const abs = join(dir, n);
    const rel = relative(paths.home, abs).split(sep).join('/');
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (excluded(rel, st.isDirectory())) continue;
    if (st.isDirectory()) walk(abs, out);
    else if (st.isFile()) out.push(rel);
  }
}

function stripSyncKey(buf: Buffer): Buffer {
  try {
    const j = JSON.parse(buf.toString('utf8'));
    if (isPlainObject(j) && 'sync' in j) {
      delete j.sync;
      return Buffer.from(JSON.stringify(j, null, 2));
    }
  } catch {
    /* not JSON: leave as-is */
  }
  return buf;
}

function collect(): Bundle {
  flushAll();
  const files: string[] = [];
  walk(paths.home, files);
  files.sort();
  const entries: Bundle['entries'] = [];
  for (const p of files) {
    let data: Buffer;
    try {
      data = readFileSync(join(paths.home, p));
    } catch {
      continue;
    }
    if (p === 'data/settings.json' || p === 'secrets.json') data = stripSyncKey(data);
    const m = statSync(join(paths.home, p)).mode & 0o777;
    entries.push({ e: { p, s: data.length, m }, data });
  }
  return { entries, home: paths.home };
}

function contentHash(b: Bundle): string {
  const h = createHash('sha256');
  for (const { e, data } of b.entries) {
    if (VOLATILE.has(e.p)) continue;
    h.update(`${e.p}\0${e.s}\0`);
    h.update(data);
  }
  return h.digest('hex');
}

const BUNDLE_MAGIC = Buffer.from('MONARCHBUNDLE\x01', 'latin1');
function serialize(b: Bundle): Buffer {
  const manifest = Buffer.from(JSON.stringify({ format: 1, home: b.home, files: b.entries.map((x) => x.e) }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length);
  return Buffer.concat([BUNDLE_MAGIC, len, manifest, ...b.entries.map((x) => x.data)]);
}
function deserialize(buf: Buffer): Bundle {
  if (!buf.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) throw new HttpError(422, 'Not a Monarch bundle');
  const len = buf.readUInt32BE(BUNDLE_MAGIC.length);
  let off = BUNDLE_MAGIC.length + 4;
  const manifest = JSON.parse(buf.subarray(off, off + len).toString('utf8')) as { format: number; home: string; files: Entry[] };
  off += len;
  const entries: Bundle['entries'] = [];
  for (const e of manifest.files) {
    if (!e.p || isAbsolute(e.p) || e.p.split('/').includes('..')) throw new HttpError(422, `Unsafe path in bundle: ${e.p}`);
    entries.push({ e, data: buf.subarray(off, off + e.s) });
    off += e.s;
  }
  return { entries, home: manifest.home };
}

/* ─────────────── crypto ─────────────── */

const ENC_MAGIC = Buffer.from('MONARCHSYNC', 'latin1');
function deriveKey(pass: string, salt: Buffer, p: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((res, rej) =>
    scryptCb(pass, salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: Math.max(KDF.maxmem, 128 * p.N * p.r * 2) }, (e, k) => (e ? rej(e) : res(k))),
  );
}

async function encrypt(plain: Buffer, pass: string | null): Promise<Buffer> {
  if (pass === null) {
    // encryption turned off (settings.sync.encrypt === false): gzip only, same container format
    const header = Buffer.from(JSON.stringify({ cipher: 'none', compression: 'gzip' }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    return Buffer.concat([ENC_MAGIC, Buffer.from([1]), len, header, gzipSync(plain, { level: 6 })]);
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(pass, salt, KDF);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(gzipSync(plain, { level: 6 })), c.final()]);
  const header = Buffer.from(
    JSON.stringify({ kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, cipher: 'aes-256-gcm', compression: 'gzip', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') }),
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([ENC_MAGIC, Buffer.from([1]), len, header, ct]);
}

async function decrypt(file: Buffer, pass: string | undefined): Promise<Buffer> {
  if (!file.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) throw new HttpError(422, 'Remote bundle is not a Monarch sync file');
  const ver = file[ENC_MAGIC.length];
  if (ver !== 1) throw new HttpError(422, `Unsupported sync format v${ver} — update Monarch`);
  const len = file.readUInt32BE(ENC_MAGIC.length + 1);
  const hStart = ENC_MAGIC.length + 5;
  const h = JSON.parse(file.subarray(hStart, hStart + len).toString('utf8'));
  if (h.cipher === 'none') return gunzipSync(file.subarray(hStart + len));
  if (!pass) throw new HttpError(400, 'This snapshot is encrypted — set the sync passphrase first');
  if (h.kdf !== 'scrypt' || h.N > 2 ** 20 || h.r > 32 || h.p > 16) throw new HttpError(422, 'Unsupported KDF parameters');
  const key = await deriveKey(pass, Buffer.from(h.salt, 'base64'), h);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(h.iv, 'base64'));
  d.setAuthTag(Buffer.from(h.tag, 'base64'));
  let gz: Buffer;
  try {
    gz = Buffer.concat([d.update(file.subarray(hStart + len)), d.final()]);
  } catch {
    throw new HttpError(401, 'Wrong sync passphrase (or corrupted bundle) — nothing was changed');
  }
  return gunzipSync(gz);
}

/* ─────────────── passphrase ─────────────── */

function passphrase(): string | undefined {
  const p = (secrets.get() as any).sync?.passphrase;
  return typeof p === 'string' && p ? p : undefined;
}
/** encryption is on unless the user turned it off in Config → Sync */
function encryptOn(): boolean {
  return (cfg() as { encrypt?: boolean }).encrypt !== false;
}
function requirePassphrase(): string {
  const p = passphrase();
  if (!p) throw new HttpError(400, 'Set a sync passphrase first');
  return p;
}

export function setPassphrase(pass: unknown): SyncStatus {
  if (typeof pass !== 'string' || pass.length < 8) throw new HttpError(400, 'Passphrase must be at least 8 characters');
  secrets.update((s) => {
    s.sync = { ...(isPlainObject(s.sync) ? s.sync : {}), passphrase: pass };
  });
  secrets.flush();
  activity('SYS', 'Sync passphrase set on this device');
  changed('sync');
  return status();
}

/* ─────────────── status ─────────────── */

function configured(s = cfg()): boolean {
  return s.provider === 'git' ? !!s.remoteUrl.trim() : !!repoName(s);
}

function displayUrl(s = cfg()): string | undefined {
  if (s.provider === 'git') return s.remoteUrl ? scrub(s.remoteUrl) : undefined;
  const r = repoName(s);
  return r ? `https://${s.host || (s.provider === 'github' ? 'github.com' : 'gitlab.com')}/${r}` : undefined;
}

let hashCache: { at: number; hash: string } | undefined;
function localHash(maxAgeMs = 5_000): string {
  if (hashCache && Date.now() - hashCache.at < maxAgeMs) return hashCache.hash;
  const hash = contentHash(collect());
  hashCache = { at: Date.now(), hash };
  return hash;
}

export function status(): SyncStatus {
  const s = cfg();
  let localChanged = true;
  try {
    localChanged = !state.baseHash || localHash() !== state.baseHash;
  } catch {
    /* ignore */
  }
  return {
    configured: configured(s),
    passphraseSet: !!passphrase(),
    remoteReady: !!state.remoteReady,
    remoteUrl: displayUrl(s),
    lastPushAt: state.lastPushAt,
    lastPullAt: state.lastPullAt,
    remote: state.remote,
    localChanged,
    busy,
    error: state.error,
  };
}

function fail(op: string, e: unknown): never {
  const msg = scrub(e instanceof Error ? e.message : String(e));
  // "not configured yet" is a normal state, not a failure worth recording or logging
  const notSetUp = e instanceof HttpError && e.status === 400 && /not configured/i.test(msg);
  if (!notSetUp) {
    saveState({ error: `${op}: ${msg}` });
    activity('SYS', `Sync ${op} failed: ${msg}`, 'error');
  }
  if (e instanceof HttpError) throw new HttpError(e.status, msg);
  throw new HttpError(500, msg);
}

/* ─────────────── connect ─────────────── */

async function prepare(): Promise<Remote> {
  const s = cfg();
  if (!configured(s)) throw new HttpError(400, 'Sync is not configured (choose a provider and repo)');
  const remote = await resolveRemote(s);
  if (s.provider !== 'git') await ensureProviderRepo(s, remote.token!);
  else {
    const r = await run('git', ['ls-remote', remote.url], { env: remote.env, timeoutMs: 60_000 });
    if (r.code !== 0) throw new HttpError(502, `Cannot reach ${remote.display}: ${scrub(r.stderr.trim()).slice(0, 400)}`);
  }
  await ensureRepoDir(remote);
  return remote;
}

export function connect(): Promise<SyncStatus> {
  return serial('check', async () => {
    try {
      const remote = await prepare();
      const tip = await fetchRemote(remote);
      const meta = tip ? await readMetaAt(remote, tip) : undefined;
      saveState({ remoteReady: true, remote: meta, error: undefined });
      activity('SYS', `Sync connected to ${remote.display}${meta ? ` (latest from ${meta.device} at ${meta.createdAt})` : ' (empty)'}`);
      return status();
    } catch (e) {
      saveState({ remoteReady: false });
      fail('connect', e);
    }
  });
}

/* ─────────────── push ─────────────── */

export function push(opts: { force?: boolean; auto?: boolean } = {}): Promise<SyncStatus> {
  return serial('push', async () => {
    try {
      const pass = encryptOn() ? requirePassphrase() : null;
      const remote = await prepare();
      const b = cfg().branch || 'main';
      const tip = await fetchRemote(remote);
      const meta = tip ? await readMetaAt(remote, tip) : undefined;
      if (tip && meta && tip !== state.baseCommit && !opts.force) {
        const since = Date.parse(state.lastPullAt && state.lastPushAt ? (state.lastPullAt > state.lastPushAt ? state.lastPullAt : state.lastPushAt) : state.lastPullAt || state.lastPushAt || '1970-01-01');
        if (meta.device !== deviceName() || !state.baseCommit || Date.parse(meta.createdAt) > since) {
          saveState({ remote: meta });
          throw new HttpError(409, `Remote has newer data from ${meta.device} at ${meta.createdAt} — pull first or force push`);
        }
      }
      const bundle = collect();
      const hash = contentHash(bundle);
      hashCache = { at: Date.now(), hash };
      if (meta && meta.contentHash === hash) {
        saveState({ baseCommit: tip, baseHash: hash, remote: meta, remoteReady: true, error: undefined });
        if (!opts.auto) activity('SYS', 'Sync: nothing changed — remote already up to date');
        return status();
      }
      const plain = serialize(bundle);
      const enc = await encrypt(plain, pass);
      // build the commit on top of the remote tip (history is kept even on force)
      if (tip) await git(['checkout', '-q', '-f', '-B', b, tip], remote);
      else {
        await git(['update-ref', '-d', `refs/heads/${b}`], remote, true);
        await git(['symbolic-ref', 'HEAD', `refs/heads/${b}`], remote);
        await git(['read-tree', '--empty'], remote);
      }
      const createdAt = nowIso();
      const snap: SyncSnapshotMeta = { format: 1, createdAt, device: deviceName(), appVersion: CORE_VERSION, files: bundle.entries.length, bytes: plain.length, contentHash: hash };
      writeFileSync(join(REPO_DIR, BUNDLE_FILE), enc);
      writeFileSync(join(REPO_DIR, META_FILE), JSON.stringify(snap, null, 2) + '\n');
      const message = `Sync from ${snap.device} at ${createdAt}`;
      await git(['add', '-f', BUNDLE_FILE, META_FILE], remote);
      await git(['-c', 'user.name=Monarch', '-c', 'user.email=monarch@localhost', 'commit', '-q', '-m', message], remote);
      await git(['push', '-q', 'origin', `HEAD:refs/heads/${b}`], remote);
      const commit = (await git(['rev-parse', 'HEAD'], remote)).stdout.trim();
      saveState({ lastPushAt: createdAt, baseCommit: commit, baseHash: hash, remote: { ...snap, commit, message }, remoteReady: true, error: undefined });
      activity('SYS', `Sync: pushed ${snap.files} files (${Math.round(enc.length / 1024)} KB encrypted) to ${remote.display}${opts.force ? ' (forced)' : ''}`);
      return status();
    } catch (e) {
      fail('push', e);
    }
  });
}

/* ─────────────── history ─────────────── */

export function history(limit = 30): Promise<SyncSnapshot[]> {
  return serial('check', async () => {
    try {
      const remote = await prepare();
      const tip = await fetchRemote(remote);
      if (!tip) return [];
      const log = await git(['log', `-n${Math.max(1, Math.min(200, limit))}`, '--format=%H', tip, '--', META_FILE], remote);
      const out: SyncSnapshot[] = [];
      for (const c of log.stdout.split('\n').map((x) => x.trim()).filter(Boolean)) {
        const m = await readMetaAt(remote, c);
        if (m) out.push(m);
      }
      saveState({ remote: out[0], remoteReady: true });
      return out;
    } catch (e) {
      fail('history', e);
    }
  }, { quiet: true });
}

/* ─────────────── pull / restore ─────────────── */

let restartHandler: ((beforeExit: () => void) => void) | undefined;
/** index.ts installs the shutdown routine: stop services, run beforeExit synchronously, exit(RESTART_EXIT_CODE) */
export function setRestartHandler(fn: (beforeExit: () => void) => void): void {
  restartHandler = fn;
}

function within(base: string, p: string): boolean {
  const r = relative(resolve(base), resolve(p));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** merge incoming settings with THIS device's local-only fields */
function mergeSettings(incoming: any, local: Settings, sourceHome: string): any {
  const out = isPlainObject(incoming) ? incoming : {};
  out.sync = local.sync;
  out.claudeSdk = { ...(out.claudeSdk ?? {}), executablePath: local.claudeSdk?.executablePath ?? '' };
  const coding = (out.coding ??= {});
  if (!coding.defaultWorkspace || !existsSync(coding.defaultWorkspace)) coding.defaultWorkspace = local.coding?.defaultWorkspace;
  const ws = [...(Array.isArray(coding.workspaces) ? coding.workspaces : []).filter((w: unknown) => typeof w === 'string' && existsSync(w)), ...(local.coding?.workspaces ?? [])];
  coding.workspaces = [...new Set(ws)];
  const mem = (out.memory ??= {});
  const v = typeof mem.vaultDir === 'string' ? mem.vaultDir : '';
  if (v && sourceHome && within(sourceHome, v)) mem.vaultDir = join(paths.home, relative(sourceHome, v));
  else if (!v || !existsSync(v)) mem.vaultDir = local.memory?.vaultDir ?? paths.vault;
  return out;
}

function backupLocal(): Promise<string> {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const file = join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
  const top = readdirSync(paths.home).filter((n) => !EXCLUDE_TOP.has(n));
  return run('tar', ['-czf', file, '--exclude=*.tmp', '--exclude=node_modules', '-C', paths.home, ...top], { timeoutMs: 300_000 }).then((r) => {
    if (r.code !== 0) throw new HttpError(500, `Backup failed: ${r.stderr.trim().slice(0, 300)}`);
    chmodSync(file, 0o600);
    const all = readdirSync(BACKUP_DIR).filter((n) => n.endsWith('.tar.gz')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) rmSync(join(BACKUP_DIR, old), { force: true });
    return file;
  });
}

/** synchronous: write the bundle into the data dir and delete local files it doesn't contain */
function applyBundle(b: Bundle): void {
  const local = getSettings();
  const localSecretsSync = (secrets.get() as any).sync;
  const keep = new Set(b.entries.map((x) => x.e.p));
  const existing: string[] = [];
  walk(paths.home, existing);
  for (const p of existing) if (!keep.has(p)) try { unlinkSync(join(paths.home, p)); } catch { /* ignore */ }
  for (const { e, data } of b.entries) {
    let buf: Buffer = data;
    if (e.p === 'data/settings.json') {
      try {
        buf = Buffer.from(JSON.stringify(mergeSettings(JSON.parse(data.toString('utf8')), local, b.home), null, 2));
      } catch {
        /* keep raw */
      }
    } else if (e.p === 'secrets.json') {
      try {
        const j = JSON.parse(data.toString('utf8'));
        if (localSecretsSync) j.sync = localSecretsSync;
        else delete j.sync;
        buf = Buffer.from(JSON.stringify(j, null, 2));
      } catch {
        /* keep raw */
      }
    }
    const abs = join(paths.home, e.p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf, { mode: e.m || 0o644 });
    try {
      chmodSync(abs, e.p === 'secrets.json' ? 0o600 : e.m || 0o644);
    } catch {
      /* windows */
    }
  }
  if (!keep.has('data/settings.json')) {
    writeFileSync(join(paths.data, 'settings.json'), JSON.stringify({ sync: local.sync }, null, 2));
  }
  if (!keep.has('secrets.json') && localSecretsSync) writeFileSync(paths.secrets, JSON.stringify({ sync: localSecretsSync }, null, 2), { mode: 0o600 });
}

export function pull(opts: { commit?: string } = {}): Promise<{ restored: true; restarting: true; restoreNow: () => void }> {
  return serial('pull', async () => {
    try {
      const pass = passphrase();
      const remote = await prepare();
      const tip = await fetchRemote(remote);
      if (!tip) throw new HttpError(404, 'The remote has no snapshots yet');
      let commit = tip;
      if (opts.commit) {
        if (!/^[0-9a-f]{4,40}$/i.test(opts.commit)) throw new HttpError(400, 'Invalid commit');
        const r = await git(['rev-parse', '--verify', `${opts.commit}^{commit}`], remote, true);
        if (r.code !== 0) throw new HttpError(404, `Unknown snapshot ${opts.commit}`);
        commit = r.stdout.trim();
      }
      const meta = await readMetaAt(remote, commit);
      const plain = await decrypt(await readBundleAt(remote, commit), pass);
      const bundle = deserialize(plain);
      const hash = contentHash(bundle);
      const tipMeta = commit === tip ? meta : await readMetaAt(remote, tip);
      const backup = await backupLocal();
      const at = nowIso();
      activity('SYS', `Sync: restoring ${bundle.entries.length} files from ${meta?.device ?? '?'} (${commit.slice(0, 8)}); backup at ${backup}; restarting core`);
      // state is device-local and written now; the data files are written right before exit (see restoreNow)
      saveState({ lastPullAt: at, baseCommit: tip, baseHash: undefined, rebase: commit === tip, remote: tipMeta, remoteReady: true, error: undefined });
      return {
        restored: true as const,
        restarting: true as const,
        restoreNow: () => {
          applyBundle(bundle);
          // when restoring an older commit, our base is the tip but content differs → localChanged
          if (commit !== tip) saveState({ baseHash: tipMeta?.contentHash ?? hash });
        },
      };
    } catch (e) {
      fail('pull', e);
    }
  });
}

/** route helper: run the restore + restart after the HTTP response is flushed */
export function scheduleRestart(restoreNow: () => void): void {
  setTimeout(() => {
    if (restartHandler) restartHandler(restoreNow);
    else {
      restoreNow();
      process.exit(RESTART_EXIT_CODE);
    }
  }, 300);
}

/* ─────────────── auto-sync ─────────────── */

let timer: NodeJS.Timeout | undefined;
let unsub: (() => void) | undefined;
let lastAutoKey = '';

function intervalMs(s = cfg()): number {
  return s.autoSync === 'hourly' ? 3_600_000 : s.autoSync === 'daily' ? 86_400_000 : 0;
}

async function autoTick(): Promise<void> {
  const s = cfg();
  if (!s.enabled || !intervalMs(s) || !configured(s) || (encryptOn() && !passphrase()) || busy) return;
  const last = Date.parse(state.lastPushAt || state.lastPullAt || '1970-01-01');
  if (Date.now() - last < intervalMs(s) - 60_000) return;
  try {
    if (state.baseHash && localHash(0) === state.baseHash) return;
    await push({ auto: true });
  } catch (e) {
    const msg = scrub(e instanceof Error ? e.message : String(e));
    notify('Monarch sync failed', msg, 'warn', '/config');
  }
}

function reschedule(): void {
  const s = cfg();
  const key = `${s.enabled}|${s.autoSync}`;
  if (key === lastAutoKey && timer) return;
  lastAutoKey = key;
  if (timer) clearInterval(timer);
  timer = undefined;
  if (s.enabled && intervalMs(s)) {
    // check every 5 minutes; autoTick decides when the interval is due
    timer = setInterval(() => void autoTick(), 5 * 60_000);
    timer.unref();
    setTimeout(() => void autoTick(), 60_000).unref();
  }
}

export function startSync(): void {
  if (state.rebase) {
    try {
      saveState({ baseHash: localHash(0), rebase: undefined });
    } catch {
      /* ignore */
    }
  }
  reschedule();
  unsub = onSettingsChanged(() => {
    reschedule();
    changed('sync');
  });
}

export function stopSync(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  unsub?.();
  unsub = undefined;
}
