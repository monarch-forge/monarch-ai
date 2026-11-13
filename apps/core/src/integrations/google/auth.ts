/**
 * Google OAuth (installed "Desktop app" client, loopback redirect + PKCE), multi-account token storage,
 * access-token refresh/caching and an authenticated fetch wrapper.
 *
 *  secrets.google.client            { clientId, clientSecret }
 *  secrets.google.accounts[id]      { refreshToken, accessToken, expiresAt, scopes }
 *  dataStore('google-accounts')     GoogleAccount[] (metadata, safe for the UI)
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CORE_HOST, CORE_PORT } from '@monarch/shared';
import type { GoogleAccount, GoogleClientConfig, OAuthFlowState } from '@monarch/shared';
import { HttpError, activity, bus, changed, dataStore, newId, nowIso, secrets } from '../../kernel.ts';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GOOGLE_REDIRECT_PATH = '/oauth/google/callback';
export const GOOGLE_REDIRECT_URI = `http://${CORE_HOST}:${CORE_PORT}${GOOGLE_REDIRECT_PATH}`;
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
];

const FLOW_TTL_MS = 10 * 60_000;

/* ─────────────── account metadata ─────────────── */

export const accountStore = dataStore<GoogleAccount[]>('google-accounts', []);

export function listAccounts(): GoogleAccount[] {
  return accountStore.get();
}

export function getAccount(id: string): GoogleAccount | undefined {
  return accountStore.get().find((a) => a.id === id || a.email.toLowerCase() === id.toLowerCase());
}

/** pick the account for an operation: explicit id/email, or the only connected one. */
export function resolveAccount(idOrEmail?: string | null): GoogleAccount {
  const accounts = listAccounts();
  if (accounts.length === 0) throw new HttpError(409, 'No Gmail account connected — connect one in Config → Accounts');
  if (idOrEmail) {
    const a = getAccount(idOrEmail);
    if (!a) {
      throw new HttpError(404, `Unknown Google account "${idOrEmail}". Connected: ${accounts.map((x) => x.email).join(', ')}`);
    }
    return a;
  }
  if (accounts.length === 1) return accounts[0];
  throw new HttpError(400, `Several Google accounts are connected — specify one of: ${accounts.map((x) => x.email).join(', ')}`);
}

function setAccountError(id: string, error: string | undefined): void {
  let mutated = false;
  accountStore.update((list) => {
    const a = list.find((x) => x.id === id);
    if (a && a.error !== error) {
      if (error) a.error = error;
      else delete a.error;
      mutated = true;
    }
  });
  if (mutated) changed('google');
}

/* ─────────────── client config ─────────────── */

export function maskSecret(s: string): string {
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}${'•'.repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}

export function getClientConfig(): GoogleClientConfig {
  const c = secrets.get().google?.client;
  return { clientId: c?.clientId ?? '', clientSecret: maskSecret(c?.clientSecret ?? ''), configured: !!(c?.clientId && c?.clientSecret) };
}

export function setClientConfig(clientId: string, clientSecret: string): GoogleClientConfig {
  clientId = (clientId ?? '').trim();
  clientSecret = (clientSecret ?? '').trim();
  if (!clientId) throw new HttpError(400, 'clientId is required');
  const prev = secrets.get().google?.client;
  // UI may send back the masked secret unchanged: keep the stored one
  if (!clientSecret || (prev && clientSecret === maskSecret(prev.clientSecret))) {
    if (!prev?.clientSecret) throw new HttpError(400, 'clientSecret is required');
    clientSecret = prev.clientSecret;
  }
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new HttpError(400, 'clientId should end with ".apps.googleusercontent.com" (OAuth client of type "Desktop app")');
  }
  secrets.update((s) => {
    s.google ??= { client: null, accounts: {} };
    s.google.client = { clientId, clientSecret };
  });
  changed('google');
  activity('SYS', 'Google OAuth client configured');
  return getClientConfig();
}

function requireClient(): { clientId: string; clientSecret: string } {
  const c = secrets.get().google?.client;
  if (!c?.clientId || !c?.clientSecret) {
    throw new HttpError(409, 'Google OAuth client not configured — add a "Desktop app" client ID/secret in Config → Accounts');
  }
  return c;
}

/* ─────────────── PKCE / auth URL ─────────────── */

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url'); // 64 chars, within 43..128
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl(opts: { clientId: string; state: string; challenge: string; loginHint?: string }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent select_account');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', opts.state);
  u.searchParams.set('code_challenge', opts.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint);
  return u.toString();
}

/* ─────────────── connect flow ─────────────── */

interface PendingFlow {
  state: OAuthFlowState;
  oauthState: string;
  verifier: string;
  createdAt: number;
  timer: NodeJS.Timeout;
}
const flows = new Map<string, PendingFlow>();

function emitFlow(f: OAuthFlowState): void {
  bus.broadcast({ type: 'oauth.progress', flow: { ...f } });
}

function finishFlow(flowId: string, patch: Partial<OAuthFlowState>): OAuthFlowState | undefined {
  const f = flows.get(flowId);
  if (!f) return undefined;
  clearTimeout(f.timer);
  flows.delete(flowId);
  Object.assign(f.state, patch);
  delete f.state.url;
  emitFlow(f.state);
  return f.state;
}

export function openInBrowser(url: string): void {
  if (process.env.MONARCH_NO_BROWSER === '1') return;
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch {
    /* best effort */
  }
}

export function startConnectFlow(opts: { open?: boolean } = {}): OAuthFlowState {
  const client = requireClient();
  const flowId = newId();
  const oauthState = randomBytes(24).toString('base64url');
  const { verifier, challenge } = pkcePair();
  const url = buildAuthUrl({ clientId: client.clientId, state: oauthState, challenge });
  const state: OAuthFlowState = {
    flowId,
    provider: 'google',
    status: 'awaiting-browser',
    url,
    instructions: 'Sign in with the Google account to connect and grant access. This tab will confirm when done.',
  };
  const timer = setTimeout(() => finishFlow(flowId, { status: 'error', error: 'Timed out waiting for Google sign-in' }), FLOW_TTL_MS);
  timer.unref?.();
  flows.set(flowId, { state, oauthState, verifier, createdAt: Date.now(), timer });
  emitFlow(state);
  if (opts.open !== false) openInBrowser(url);
  return { ...state };
}

/** cancel a pending Google flow (returns false if unknown). Exposed for /api/oauth/:flowId/cancel. */
export function cancelGoogleFlow(flowId: string): boolean {
  return !!finishFlow(flowId, { status: 'error', error: 'Cancelled' });
}

export function getGoogleFlow(flowId: string): OAuthFlowState | undefined {
  const f = flows.get(flowId);
  return f ? { ...f.state } : undefined;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new HttpError(502, `Could not reach Google token endpoint: ${(e as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    const err = new HttpError(res.status === 400 || res.status === 401 ? 400 : 502, `Google token error: ${json.error ?? res.status}${json.error_description ? ` — ${json.error_description}` : ''}`);
    (err as HttpError & { code?: string }).code = json.error;
    throw err;
  }
  return json;
}

/** handle the loopback redirect; returns a result for the HTML page */
export async function handleOAuthCallback(q: { code?: string; state?: string; error?: string }): Promise<{ ok: boolean; message: string; account?: GoogleAccount }> {
  const entry = [...flows.values()].find((f) => f.oauthState === q.state);
  if (!entry) return { ok: false, message: 'This sign-in link has expired or was already used. Start again from Monarch.' };
  const flowId = entry.state.flowId;
  if (q.error) {
    finishFlow(flowId, { status: 'error', error: q.error === 'access_denied' ? 'Access was denied' : `Google returned: ${q.error}` });
    return { ok: false, message: q.error === 'access_denied' ? 'Access was denied.' : `Google returned an error: ${q.error}` };
  }
  if (!q.code) {
    finishFlow(flowId, { status: 'error', error: 'Missing authorization code' });
    return { ok: false, message: 'Missing authorization code.' };
  }
  entry.state.status = 'working';
  entry.state.message = 'Exchanging authorization code…';
  emitFlow(entry.state);
  try {
    const client = requireClient();
    const tok = await postToken({
      code: q.code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: entry.verifier,
    });
    const info = await fetchUserInfo(tok.access_token);
    const scopes = (tok.scope ?? GOOGLE_SCOPES.join(' ')).split(/\s+/).filter(Boolean);
    const id = info.sub;
    const prevSecret = secrets.get().google.accounts[id];
    const refreshToken = tok.refresh_token ?? prevSecret?.refreshToken;
    if (!refreshToken) throw new Error('Google did not return a refresh token — remove Monarch from your Google account permissions and try again');
    secrets.update((s) => {
      s.google.accounts[id] = { refreshToken, accessToken: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000, scopes };
    });
    tokenCache.set(id, { token: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 });
    const prev = getAccount(id);
    const account: GoogleAccount = {
      id,
      email: info.email,
      name: info.name,
      picture: info.picture,
      scopes,
      connectedAt: prev?.connectedAt ?? nowIso(),
      label: prev?.label ?? info.email.split('@')[0],
    };
    accountStore.update((list) => {
      const i = list.findIndex((a) => a.id === id);
      if (i >= 0) list[i] = account;
      else list.push(account);
    });
    const missing = ['gmail.modify', 'gmail.send', 'calendar'].filter((s) => !scopes.some((x) => x.endsWith(`/auth/${s}`)));
    finishFlow(flowId, {
      status: 'done',
      message: missing.length ? `Connected ${info.email} (missing permissions: ${missing.join(', ')})` : `Connected ${info.email}`,
    });
    changed('google');
    changed('mail');
    changed('events');
    activity('MAIL', `Google account connected: ${info.email}`);
    return { ok: true, message: `${info.email} is connected.`, account };
  } catch (e) {
    const msg = (e as Error).message;
    finishFlow(flowId, { status: 'error', error: msg });
    activity('ERR', `Google connect failed: ${msg}`, 'error');
    return { ok: false, message: msg };
  }
}

async function fetchUserInfo(accessToken: string): Promise<{ sub: string; email: string; name?: string; picture?: string }> {
  const res = await fetch(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Could not read Google profile (${res.status})`);
  const j = (await res.json()) as { sub: string; email: string; name?: string; picture?: string };
  if (!j.sub || !j.email) throw new Error('Google profile is missing id/email (were the openid/email scopes granted?)');
  return j;
}

/* ─────────────── tokens ─────────────── */

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const refreshing = new Map<string, Promise<string>>();

export async function getAccessToken(accountId: string, force = false): Promise<string> {
  const now = Date.now();
  if (!force) {
    const cached = tokenCache.get(accountId);
    if (cached && cached.expiresAt - 60_000 > now) return cached.token;
    const stored = secrets.get().google.accounts[accountId];
    if (stored?.accessToken && stored.expiresAt && stored.expiresAt - 60_000 > now) {
      tokenCache.set(accountId, { token: stored.accessToken, expiresAt: stored.expiresAt });
      return stored.accessToken;
    }
  }
  const pending = refreshing.get(accountId);
  if (pending) return pending;
  const p = refreshAccessToken(accountId).finally(() => refreshing.delete(accountId));
  refreshing.set(accountId, p);
  return p;
}

async function refreshAccessToken(accountId: string): Promise<string> {
  const stored = secrets.get().google.accounts[accountId];
  const acct = getAccount(accountId);
  if (!stored?.refreshToken) {
    setAccountError(accountId, 'No credentials stored — reconnect this account');
    throw new HttpError(409, `Google account ${acct?.email ?? accountId} has no stored credentials — reconnect it in Config → Accounts`);
  }
  const client = requireClient();
  try {
    const tok = await postToken({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: 'refresh_token',
    });
    const expiresAt = Date.now() + tok.expires_in * 1000;
    tokenCache.set(accountId, { token: tok.access_token, expiresAt });
    secrets.update((s) => {
      const a = s.google.accounts[accountId];
      if (a) {
        a.accessToken = tok.access_token;
        a.expiresAt = expiresAt;
        if (tok.refresh_token) a.refreshToken = tok.refresh_token;
      }
    });
    setAccountError(accountId, undefined);
    return tok.access_token;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'invalid_grant') {
      setAccountError(accountId, 'Authorization expired or was revoked — reconnect this account');
      activity('MAIL', `Google account ${acct?.email ?? accountId} needs to be reconnected`, 'warn');
      throw new HttpError(409, `Google authorization for ${acct?.email ?? accountId} expired or was revoked — reconnect it in Config → Accounts`);
    }
    if (code === 'invalid_client' || code === 'unauthorized_client') {
      throw new HttpError(409, 'Google OAuth client was rejected — check the client ID/secret in Config → Accounts');
    }
    throw e;
  }
}

export async function removeAccount(id: string): Promise<boolean> {
  const acct = getAccount(id);
  const realId = acct?.id ?? id;
  const stored = secrets.get().google.accounts[realId];
  if (!acct && !stored) return false;
  if (stored?.refreshToken) {
    // best-effort revoke; never block removal on it
    fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: stored.refreshToken }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
  secrets.update((s) => {
    delete s.google.accounts[realId];
  });
  tokenCache.delete(realId);
  accountStore.update((list) => list.filter((a) => a.id !== realId));
  changed('google');
  changed('mail');
  changed('events');
  activity('MAIL', `Google account removed: ${acct?.email ?? realId}`);
  return true;
}

/* ─────────────── authenticated fetch ─────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch a Google API with the account's bearer token; JSON in/out; maps errors to HttpError. */
export async function googleFetch<T = unknown>(
  accountId: string,
  url: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | string[] | undefined> } = {},
): Promise<T> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v === undefined || v === '') continue;
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
    else u.searchParams.set(k, String(v));
  }
  let attempt = 0;
  let forceRefresh = false;
  for (;;) {
    attempt++;
    const token = await getAccessToken(accountId, forceRefresh);
    let res: Response;
    try {
      res = await fetch(u, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      if (attempt < 2) continue;
      throw new HttpError(502, `Google API unreachable: ${(e as Error).message}`);
    }
    if (res.status === 401 && attempt < 2) {
      forceRefresh = true;
      continue;
    }
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Math.min(10_000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * attempt)));
      continue;
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-json */
    }
    if (!res.ok) {
      const msg = json?.error?.message ?? json?.error_description ?? (typeof json?.error === 'string' ? json.error : text.slice(0, 200));
      const status = res.status === 404 ? 404 : res.status === 400 ? 400 : 502;
      throw new HttpError(status, `Google API ${res.status}: ${msg || res.statusText}`);
    }
    return json as T;
  }
}

/** run `fn` over items with at most `limit` in flight; preserves order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** HTML page shown in the browser after the OAuth redirect */
export function callbackPage(ok: boolean, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const title = ok ? 'Account connected' : 'Connection failed';
  const sub = ok ? 'You can close this tab and return to Monarch.' : 'Return to Monarch and try again.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monarch — ${title}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121213;color:#F4F4F6;font:14px/1.5 Geist,ui-sans-serif,system-ui,sans-serif}
  .card{width:min(440px,calc(100vw - 32px));background:#1C1C1E;border:1px solid #323236;padding:28px 28px 24px}
  .label{font:11px/1 'Geist Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#9E9EA4;display:flex;gap:8px;align-items:center}
  .dot{width:8px;height:8px;background:${ok ? '#F4F4F6' : '#D71921'}}
  h1{font-size:20px;font-weight:600;margin:16px 0 6px}
  p{margin:0;color:#9E9EA4}
  .msg{margin-top:14px;padding-top:14px;border-top:1px solid #323236;color:#F4F4F6;word-break:break-word}
</style></head><body><main class="card">
<div class="label"><span class="dot"></span>Monarch · Google</div>
<h1>${ok ? 'Account connected — you can close this tab' : title}</h1>
<p>${esc(sub)}</p>
<div class="msg">${esc(message)}</div>
</main>${ok ? '<script>setTimeout(()=>{try{window.close()}catch(e){}},2500)</script>' : ''}</body></html>`;
}
