/**
 * Phone access: an optional SECOND listener (Tailscale or a private LAN address, never 0.0.0.0) that serves the built UI
 * and the full API to paired devices only. The desktop listener on 127.0.0.1 is untouched.
 *   - off by default; config in data/remote.json, device tokens stored as sha256 hashes in secrets.json (remoteDevices)
 *   - pairing: the desktop asks for a one-time code (5 min); the phone opens /pair?code=… and exchanges it for a random
 *     32-byte token, set as an HttpOnly SameSite=Strict cookie (or sent as `Authorization: Bearer`)
 *   - every remote request/WebSocket needs a valid token; Host must be the bound address (DNS-rebinding guard);
 *     /api/remote/* (pairing, devices, config) is never reachable from the remote listener
 */
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { activity, dataStore, HttpError, newId, nowIso, secrets } from '../kernel.ts';
import { attachWebSocket, createApp, dropSockets } from '../server.ts';
import { hashToken, Pairing, tokenMatches, TooManyAttempts } from './remote-auth.ts';

export interface RemoteConfig {
  enabled: boolean;
  iface: 'tailscale' | 'lan';
  /** LAN address (iface 'lan' only) */
  address: string;
  port: number;
}
export interface RemoteDevice {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeen: string | null;
}

const COOKIE = 'monarch_device';
const config = dataStore<RemoteConfig>('remote', { enabled: false, iface: 'tailscale', address: '', port: 7720 });

const pairing = new Pairing();

/* ─────────────── devices ─────────────── */

function devices(): RemoteDevice[] {
  const s = secrets.get();
  if (!Array.isArray(s.remoteDevices)) s.remoteDevices = [];
  return s.remoteDevices as RemoteDevice[];
}

function addDevice(name: string): string {
  const token = randomBytes(32).toString('base64url');
  devices().push({ id: newId(), name: name.slice(0, 60) || 'Phone', tokenHash: hashToken(token), createdAt: nowIso(), lastSeen: nowIso() });
  secrets.save();
  return token;
}

function deviceFor(token: string | undefined): RemoteDevice | null {
  if (!token) return null;
  let hit: RemoteDevice | null = null;
  for (const d of devices()) if (tokenMatches(token, d.tokenHash)) hit = d; // no early exit
  if (hit && (!hit.lastSeen || Date.now() - Date.parse(hit.lastSeen) > 60_000)) {
    hit.lastSeen = nowIso();
    secrets.save();
  }
  return hit;
}

function tokenFrom(headers: { cookie?: string | null; authorization?: string | null }): string | undefined {
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1];
  return bearer ?? /(?:^|;\s*)monarch_device=([^;\s]+)/.exec(headers.cookie ?? '')?.[1];
}

export function revokeDevice(id: string): void {
  const list = devices();
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) throw new HttpError(404, 'Unknown device');
  const [d] = list.splice(i, 1);
  secrets.save();
  dropSockets((tag) => tag === `remote:${id}`);
  activity('SYS', `Phone access revoked for ${d.name}`);
}

/* ─────────────── addresses ─────────────── */

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function tailscaleIp(): Promise<string | null> {
  return new Promise((res) =>
    execFile('tailscale', ['ip', '-4'], { timeout: 3000 }, (err, out) => {
      const ip = err ? '' : String(out).split('\n')[0].trim();
      res(/^100\.\d+\.\d+\.\d+$/.test(ip) ? ip : null);
    }),
  );
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && PRIVATE_V4.test(a.address)) out.push(a.address);
  // tests only: bind to a loopback alias instead of a real interface
  const t = process.env.MONARCH_REMOTE_TEST_HOST;
  if (t && /^127\.\d+\.\d+\.\d+$/.test(t)) out.push(t);
  return out;
}

async function bindAddress(c: RemoteConfig): Promise<string> {
  if (c.iface === 'tailscale') {
    const ip = await tailscaleIp();
    if (!ip) throw new Error('Tailscale is not running (no `tailscale ip -4`)');
    return ip;
  }
  if (!lanAddresses().includes(c.address)) throw new Error(`${c.address || 'No address'} is not a private address of this machine`);
  return c.address;
}

/* ─────────────── static UI ─────────────── */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** built UI: MONARCH_UI_DIST, else <core.mjs dir>/ui (packaged, staged by scripts/bundle-core.mjs), else apps/ui/dist (repo) */
function uiDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [process.env.MONARCH_UI_DIST, join(here, 'ui'), resolve(here, '../../../ui/dist')])
    if (d && existsSync(join(d, 'index.html'))) return resolve(d);
  return null;
}

function serveStatic(root: string, urlPath: string): Response {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return new Response('Bad path', { status: 400 });
  }
  let file = resolve(root, '.' + rel);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) file = join(root, 'index.html'); // SPA fallback
  const isAsset = file.startsWith(join(root, 'assets') + sep);
  return new Response(readFileSync(file), {
    headers: {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  });
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{font:16px system-ui;background:#0b0d12;color:#e6e8ee;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:340px;padding:24px}` +
  `input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;margin-top:10px;border-radius:10px;border:1px solid #333;background:#151821;color:inherit}` +
  `button{background:#e0a030;color:#111;border:0;font-weight:600}</style></head><body><main>${body}</main></body></html>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/* ─────────────── remote listener ─────────────── */

const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/monarch.svg', '/icons/icon-256.png', '/icons/icon-512.png']);

export function buildRemoteApp(addr: string, port: number, root: string | null): Hono {
  const selfHost = `${addr}:${port}`;
  const selfOrigin = `http://${selfHost}`;
  const sameOrigin = (o: string | undefined | null) => !o || o === selfOrigin;
  const app = new Hono();

  app.use('*', async (c, next) => {
    // shortcut: only the raw IP is accepted as Host (no MagicDNS name); add names here if wanted
    if (c.req.header('host') !== selfHost) return c.text('Misdirected request', 421);
    if (!sameOrigin(c.req.header('origin'))) return c.json({ error: 'origin not allowed' }, 403);
    const p = c.req.path;
    if (p === '/pair' || PUBLIC_PATHS.has(p)) return next();
    const dev = deviceFor(tokenFrom({ cookie: c.req.header('cookie'), authorization: c.req.header('authorization') }));
    if (!dev) {
      if (p.startsWith('/api/') || c.req.method !== 'GET') return c.json({ error: 'Not paired' }, 401);
      return c.html(page('Monarch', '<h2>Not paired</h2><p>Open Monarch on your computer → Config → Phone access and scan the pairing code.</p>'), 401);
    }
    if (p === '/api/remote' || p.startsWith('/api/remote/')) return c.json({ error: 'Phone access is managed from the desktop app' }, 403);
    await next();
  });

  app.get('/pair', (c) => {
    const code = c.req.query('code') ?? '';
    // a page with a button (not an auto-redeem) so link previewers cannot burn the one-time code
    return c.html(
      page(
        'Pair with Monarch',
        `<h2>Pair this device</h2><p>This gives the device full access to your Monarch assistant.</p><form method="post" action="/pair">` +
          `<input type="hidden" name="code" value="${esc(code)}"><input name="name" placeholder="Device name" maxlength="60" value="Phone">` +
          `<button type="submit">Pair</button></form>`,
      ),
    );
  });

  app.post('/pair', async (c) => {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const code = typeof body.code === 'string' ? body.code : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!pairing.redeem(code)) return c.html(page('Monarch', '<h2>Pairing failed</h2><p>The code is wrong, used or expired. Generate a new one on the desktop.</p>'), 401);
    const token = addDevice(name);
    activity('SYS', `Phone paired: ${name || 'Phone'}`);
    c.header('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    return c.redirect('/', 303);
  });

  app.route('/', createApp(sameOrigin));

  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/') || c.req.path === '/ws') return c.json({ error: 'Not found' }, 404);
    return root ? serveStatic(root, c.req.path) : c.text('UI not built (npm run build -w @monarch/ui)', 503);
  });
  app.onError((err, c) => {
    const st = err instanceof HttpError || err instanceof TooManyAttempts ? err.status : 500;
    if (st >= 500) console.error(`[remote] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: err.message || 'Internal error' }, st as 500);
  });
  return app;
}

let running: { server: Server; ws: { close(): void }; address: string; port: number } | null = null;
let lastError: string | null = null;

export async function stopRemote(): Promise<void> {
  const r = running;
  running = null;
  pairing.cancel();
  if (!r) return;
  r.ws.close();
  dropSockets((tag) => tag.startsWith('remote:'));
  await new Promise<void>((res) => {
    r.server.close(() => res());
    r.server.closeAllConnections?.();
  });
}

export async function startRemote(): Promise<void> {
  await stopRemote();
  lastError = null;
  const c = config.get();
  if (!c.enabled) return;
  try {
    const address = await bindAddress(c);
    const app = buildRemoteApp(address, c.port, uiDir());
    const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server;
    const ws = attachWebSocket(server, (req: IncomingMessage) => {
      if (req.headers.host !== `${address}:${c.port}`) return null;
      if (req.headers.origin && req.headers.origin !== `http://${address}:${c.port}`) return null;
      const dev = deviceFor(tokenFrom({ cookie: req.headers.cookie, authorization: req.headers.authorization }));
      return dev ? `remote:${dev.id}` : null;
    });
    await new Promise<void>((res, rej) => {
      server.once('error', rej);
      server.listen(c.port, address, () => {
        server.off('error', rej);
        res();
      });
    });
    running = { server, ws, address, port: c.port };
    console.log(`[core] phone access on http://${address}:${c.port}`);
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error('[core] phone access failed:', lastError);
  }
}

/* ─────────────── API (desktop only) ─────────────── */

export async function remoteStatus() {
  const tailscale = await tailscaleIp();
  return {
    config: config.get(),
    running: running ? { address: running.address, port: running.port, url: `http://${running.address}:${running.port}` } : null,
    error: lastError,
    tailscale,
    lan: lanAddresses(),
    uiBuilt: !!uiDir(),
    devices: devices().map(({ tokenHash: _h, ...d }) => d),
  };
}

export async function setRemoteConfig(patch: Partial<RemoteConfig>) {
  const c = { ...config.get() };
  if (typeof patch.enabled === 'boolean') c.enabled = patch.enabled;
  if (patch.iface === 'tailscale' || patch.iface === 'lan') c.iface = patch.iface;
  if (typeof patch.address === 'string') c.address = patch.address.trim();
  if (patch.port !== undefined) {
    const p = Number(patch.port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535 || p === 7717 || p === 7719) throw new HttpError(400, 'Port must be 1024–65535 and not 7717/7719');
    c.port = p;
  }
  config.set(c);
  await startRemote();
  activity('SYS', c.enabled ? `Phone access ${running ? 'on' : 'failed'}` : 'Phone access off');
  return remoteStatus();
}

export async function newPairingCode() {
  if (!running) throw new HttpError(409, 'Phone access is not running');
  const { code, expiresAt } = pairing.create();
  const url = `http://${running.address}:${running.port}/pair?code=${code}`;
  const QR = await import('qrcode');
  const qrSvg = await QR.toString(url, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
  return { code, expiresAt, url, qrSvg };
}
