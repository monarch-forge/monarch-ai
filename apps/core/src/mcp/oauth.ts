/**
 * OAuth for remote (http/sse) MCP servers — the MCP authorization spec (RFC 9728 discovery, dynamic client
 * registration, PKCE) via the SDK's `auth()`. Tokens/client info live in secrets.mcpOauth[serverId] and never
 * leave the core. Flow: a 401 makes the SDK call redirectToAuthorization → we keep the URL as `pendingUrl`; the UI
 * opens it; the provider redirects to /mcp/oauth/callback, which exchanges the code and reconnects the server.
 */
import { randomBytes } from 'node:crypto';
import { CORE_HOST, CORE_PORT } from '@monarch/shared';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { secrets } from '../kernel.ts';

export const MCP_OAUTH_PATH = '/mcp/oauth/callback';
const port = (): number => Number(process.env.MONARCH_PORT) || CORE_PORT;
export const mcpRedirectUri = (): string => `http://${process.env.MONARCH_HOST || CORE_HOST}:${port()}${MCP_OAUTH_PATH}`;

interface OauthBag {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  state?: string;
  discovery?: OAuthDiscoveryState;
  /** redirect uri the client was registered with (re-register if the port changes) */
  redirectUri?: string;
}

/** authorization URLs waiting for the user, by server id (memory only) */
const pending = new Map<string, string>();
export const pendingAuthUrl = (id: string): string | undefined => pending.get(id);

function bag(id: string): OauthBag {
  const s = secrets.get() as Record<string, any>;
  return { ...(s.mcpOauth?.[id] ?? {}) };
}
function save(id: string, patch: Partial<OauthBag>): void {
  secrets.update((s: Record<string, any>) => {
    s.mcpOauth = { ...(s.mcpOauth ?? {}) };
    const next: Record<string, unknown> = { ...(s.mcpOauth[id] ?? {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    if (Object.keys(next).length) s.mcpOauth[id] = next;
    else delete s.mcpOauth[id];
  });
}

export function hasOauthTokens(id: string): boolean {
  return !!bag(id).tokens?.access_token;
}

/** sign out / forget everything (server removed or URL changed) */
export function forgetOauth(id: string): void {
  pending.delete(id);
  secrets.update((s: Record<string, any>) => {
    if (s.mcpOauth) delete s.mcpOauth[id];
  });
}

export function oauthProvider(id: string): OAuthClientProvider {
  const redirectUri = mcpRedirectUri();
  return {
    get redirectUrl() {
      return redirectUri;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'Monarch AI',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state() {
      const st = `${id}.${randomBytes(16).toString('hex')}`;
      save(id, { state: st });
      return st;
    },
    clientInformation() {
      const b = bag(id);
      return b.redirectUri === redirectUri ? b.client : undefined;
    },
    saveClientInformation(client) {
      save(id, { client, redirectUri });
    },
    tokens() {
      return bag(id).tokens;
    },
    saveTokens(tokens) {
      pending.delete(id);
      save(id, { tokens, verifier: undefined, state: undefined });
    },
    redirectToAuthorization(url) {
      pending.set(id, url.toString());
    },
    saveCodeVerifier(verifier) {
      save(id, { verifier });
    },
    codeVerifier() {
      const v = bag(id).verifier;
      if (!v) throw new Error('no PKCE verifier saved — start sign-in again');
      return v;
    },
    saveDiscoveryState(discovery) {
      save(id, { discovery });
    },
    discoveryState() {
      return bag(id).discovery;
    },
    invalidateCredentials(scope) {
      if (scope === 'all') return save(id, { client: undefined, tokens: undefined, verifier: undefined, discovery: undefined });
      if (scope === 'client') return save(id, { client: undefined });
      if (scope === 'tokens') return save(id, { tokens: undefined });
      if (scope === 'verifier') return save(id, { verifier: undefined });
      if (scope === 'discovery') return save(id, { discovery: undefined });
    },
  };
}

/** begin (or resume) sign-in; returns the URL to open, or null when tokens were already valid/refreshable */
export async function startOauth(id: string, serverUrl: string): Promise<string | null> {
  pending.delete(id);
  const r = await auth(oauthProvider(id), { serverUrl });
  return r === 'REDIRECT' ? (pending.get(id) ?? null) : null;
}

/** finish sign-in from the callback; returns the server id */
export async function finishOauth(state: string, code: string, serverUrlOf: (id: string) => string | undefined): Promise<string> {
  const id = state.split('.')[0] ?? '';
  const b = bag(id);
  if (!id || !b.state || b.state !== state) throw new Error('unknown or expired sign-in (state mismatch) — start again from Evolve → MCP');
  const url = serverUrlOf(id);
  if (!url) throw new Error(`MCP server "${id}" no longer exists`);
  await auth(oauthProvider(id), { serverUrl: url, authorizationCode: code });
  return id;
}
