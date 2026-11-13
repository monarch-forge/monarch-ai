/**
 * Slack (multi-workspace) via the Web API with user (xoxp-) or bot (xoxb-) tokens.
 *  secrets.slack[teamId] = { token }            (never leaves the core)
 *  dataStore('slack-workspaces') SlackWorkspace[]
 */
import type { SlackChannel, SlackMessage, SlackWorkspace } from '@monarch/shared';
import { HttpError, activity, changed, dataStore, nowIso, secrets } from '../../kernel.ts';

const SLACK_API = 'https://slack.com/api';

export const workspaceStore = dataStore<SlackWorkspace[]>('slack-workspaces', []);

/** test hook: override the API base (e.g. a local mock server) */
let apiBase = SLACK_API;
export function _setSlackApiBase(url: string): void {
  apiBase = url;
}

/* ─────────────── errors ─────────────── */

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'no_permission', 'org_login_required']);

export class SlackError extends HttpError {
  constructor(status: number, message: string, public code: string) {
    super(status, message);
  }
}

function friendly(method: string, code: string, needed?: string): SlackError {
  switch (code) {
    case 'invalid_auth':
    case 'not_authed':
      return new SlackError(400, 'Slack rejected the token (invalid_auth) — check that you copied the full xoxp-/xoxb- token', code);
    case 'token_revoked':
    case 'token_expired':
      return new SlackError(409, `Slack token was ${code === 'token_revoked' ? 'revoked' : 'expired'} — reconnect the workspace in Config → Accounts`, code);
    case 'account_inactive':
      return new SlackError(409, 'Slack account/app for this token is inactive — reconnect the workspace', code);
    case 'missing_scope':
      return new SlackError(502, `Slack token is missing a scope for ${method}${needed ? `: add "${needed}" to the app's scopes and reinstall` : ''}`, code);
    case 'channel_not_found':
      return new SlackError(404, 'Slack channel not found (or the token cannot see it)', code);
    case 'not_in_channel':
      return new SlackError(400, 'Not a member of that channel — join it in Slack (or invite the bot) first', code);
    case 'is_archived':
      return new SlackError(400, 'That channel is archived', code);
    case 'msg_too_long':
      return new SlackError(400, 'Message is too long for Slack', code);
    case 'no_text':
      return new SlackError(400, 'Message text is empty', code);
    case 'not_allowed_token_type':
      return new SlackError(400, `This Slack token type cannot call ${method}${method === 'search.messages' ? ' — search needs a user token (xoxp-)' : ''}`, code);
    case 'ratelimited':
      return new SlackError(502, 'Slack rate limit hit — try again shortly', code);
    default:
      return new SlackError(502, `Slack ${method} failed: ${code}`, code);
  }
}

/* ─────────────── low-level call ─────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** call a Slack Web API method (form-encoded POST); retries once on HTTP 429 honoring Retry-After. */
export async function slackCall<T = Record<string, any>>(token: string, method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') body.set(k, String(v));
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${apiBase}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new SlackError(502, `Slack API unreachable: ${(e as Error).message}`, 'network');
    }
    if (res.status === 429) {
      if (attempt >= 2) throw friendly(method, 'ratelimited');
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Math.min(30, Number.isFinite(ra) && ra > 0 ? ra : 1) * 1000);
      continue;
    }
    const json = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string; needed?: string }) | null;
    if (!json) throw new SlackError(502, `Slack ${method}: HTTP ${res.status} with non-JSON response`, 'bad_response');
    if (!json.ok) throw friendly(method, json.error ?? 'unknown_error', json.needed);
    return json;
  }
}

/* ─────────────── workspaces ─────────────── */

export function listWorkspaces(): SlackWorkspace[] {
  return workspaceStore.get();
}

export function tokenTypeOf(token: string, botId?: string): 'user' | 'bot' {
  if (/(^|\.)xoxb-/.test(token)) return 'bot';
  if (/(^|\.)xoxp-/.test(token)) return 'user';
  return botId ? 'bot' : 'user';
}

export async function addWorkspace(rawToken: string): Promise<SlackWorkspace> {
  const token = (rawToken ?? '').trim();
  if (!token) throw new HttpError(400, 'token is required');
  if (!/^xox[a-z][-.]/.test(token)) throw new HttpError(400, 'That does not look like a Slack token (expected xoxp-… user token or xoxb-… bot token)');
  if (token.startsWith('xoxc-') || token.startsWith('xoxd-')) {
    throw new HttpError(400, 'Browser session tokens (xoxc/xoxd) are not supported — create a Slack app and use its User OAuth Token (xoxp-…)');
  }
  const r = await slackCall<{ team_id: string; team: string; user?: string; user_id?: string; bot_id?: string; url?: string }>(token, 'auth.test');
  const ws: SlackWorkspace = {
    id: r.team_id,
    name: r.team,
    user: r.user,
    tokenType: tokenTypeOf(token, r.bot_id),
    connectedAt: listWorkspaces().find((w) => w.id === r.team_id)?.connectedAt ?? nowIso(),
  };
  secrets.update((s) => {
    s.slack ??= {};
    s.slack[ws.id] = { token };
  });
  workspaceStore.update((list) => {
    const i = list.findIndex((w) => w.id === ws.id);
    if (i >= 0) list[i] = ws;
    else list.push(ws);
  });
  meta.delete(ws.id);
  changed('slack');
  activity('SLK', `Slack workspace connected: ${ws.name} (${ws.tokenType} token)`);
  return ws;
}

export function removeWorkspace(id: string): boolean {
  const ws = listWorkspaces().find((w) => w.id === id);
  const had = !!secrets.get().slack?.[id];
  if (!ws && !had) return false;
  secrets.update((s) => {
    delete s.slack[id];
  });
  workspaceStore.update((list) => list.filter((w) => w.id !== id));
  meta.delete(id);
  changed('slack');
  activity('SLK', `Slack workspace removed: ${ws?.name ?? id}`);
  return true;
}

/** pick a workspace: explicit id or (case-insensitive) name, or the only connected one */
export function resolveWorkspace(idOrName?: string | null): SlackWorkspace {
  const list = listWorkspaces();
  if (!list.length) throw new HttpError(409, 'No Slack workspace connected — connect one in Config → Accounts');
  if (idOrName) {
    const q = idOrName.toLowerCase();
    const ws = list.find((w) => w.id === idOrName || w.name.toLowerCase() === q);
    if (!ws) throw new HttpError(404, `Unknown Slack workspace "${idOrName}". Connected: ${list.map((w) => `${w.name} (${w.id})`).join(', ')}`);
    return ws;
  }
  if (list.length === 1) return list[0];
  throw new HttpError(400, `Several Slack workspaces are connected — specify one of: ${list.map((w) => `${w.name} (${w.id})`).join(', ')}`);
}

function setWorkspaceError(id: string, error: string | undefined): void {
  let mutated = false;
  workspaceStore.update((list) => {
    const w = list.find((x) => x.id === id);
    if (w && w.error !== error) {
      if (error) w.error = error;
      else delete w.error;
      mutated = true;
    }
  });
  if (mutated) changed('slack');
}

/** call with the workspace's stored token; records auth failures on the workspace */
async function wsCall<T = Record<string, any>>(ws: SlackWorkspace, method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const token = secrets.get().slack?.[ws.id]?.token;
  if (!token) throw new HttpError(409, `No token stored for Slack workspace ${ws.name} — reconnect it in Config → Accounts`);
  try {
    const r = await slackCall<T>(token, method, params);
    if (ws.error) setWorkspaceError(ws.id, undefined);
    return r;
  } catch (e) {
    if (e instanceof SlackError && AUTH_ERRORS.has(e.code)) setWorkspaceError(ws.id, e.message);
    throw e;
  }
}

/* ─────────────── users ─────────────── */

interface WsMeta {
  users: Map<string, string>;
  channels: { at: number; list: SlackChannel[] } | null;
}
const meta = new Map<string, WsMeta>();
function metaOf(id: string): WsMeta {
  let m = meta.get(id);
  if (!m) meta.set(id, (m = { users: new Map(), channels: null }));
  return m;
}

interface SUser {
  id: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}
const displayName = (u: SUser) => u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id;

async function resolveUsers(ws: SlackWorkspace, ids: string[]): Promise<Map<string, string>> {
  const m = metaOf(ws.id);
  const missing = [...new Set(ids.filter((id) => id && !m.users.has(id)))];
  let i = 0;
  const worker = async () => {
    while (i < missing.length) {
      const id = missing[i++];
      try {
        const r = await wsCall<{ user: SUser }>(ws, 'users.info', { user: id });
        m.users.set(id, displayName(r.user));
      } catch {
        m.users.set(id, id); // don't retry endlessly; fall back to id
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, missing.length) }, worker));
  return m.users;
}

/* ─────────────── channels ─────────────── */

interface SConv {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  user?: string;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

function kindOf(c: SConv): SlackChannel['kind'] {
  if (c.is_im) return 'dm';
  if (c.is_mpim) return 'group-dm';
  if (c.is_private || c.is_group) return 'private';
  return 'channel';
}

/** "mpdm-alice--bob--carol-1" → "alice, bob, carol" */
export function mpimName(name: string): string {
  return name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').join(', ');
}

/**
 * Conversations the token's user/bot is a member of (users.conversations — same shape as
 * conversations.list but scoped to what's relevant for a personal inbox). Cached 2 min.
 */
export async function listChannels(workspaceId?: string, opts: { refresh?: boolean } = {}): Promise<SlackChannel[]> {
  const ws = resolveWorkspace(workspaceId);
  const m = metaOf(ws.id);
  if (!opts.refresh && m.channels && Date.now() - m.channels.at < 120_000) return m.channels.list;
  const convs: SConv[] = [];
  let cursor: string | undefined;
  do {
    const r = await wsCall<{ channels: SConv[]; response_metadata?: { next_cursor?: string } }>(ws, 'users.conversations', {
      types: 'public_channel,private_channel,im,mpim',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    convs.push(...(r.channels ?? []));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor && convs.length < 1000);
  const users = await resolveUsers(ws, convs.filter((c) => c.is_im && c.user).map((c) => c.user!));
  const list: SlackChannel[] = convs
    .filter((c) => !c.is_archived)
    .map((c) => {
      const kind = kindOf(c);
      const ch: SlackChannel = {
        id: c.id,
        workspaceId: ws.id,
        name: kind === 'dm' ? (users.get(c.user!) ?? c.user ?? c.id) : kind === 'group-dm' ? mpimName(c.name ?? c.id) : (c.name ?? c.id),
        kind,
      };
      const topic = c.topic?.value || c.purpose?.value;
      if (topic) ch.topic = topic;
      if (typeof c.num_members === 'number') ch.memberCount = c.num_members;
      return ch;
    })
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name));
  m.channels = { at: Date.now(), list };
  return list;
}
const kindRank = (k: SlackChannel['kind']) => ({ channel: 0, private: 1, 'group-dm': 2, dm: 3 })[k];

/** resolve "C0123", "#general", "general", or a DM user's name → channel id */
export async function resolveChannel(workspaceId: string | undefined, ref: string): Promise<SlackChannel | { id: string; name: string }> {
  const r = ref.trim();
  if (/^[CDG][A-Z0-9]{6,}$/.test(r)) {
    const list = await listChannels(workspaceId).catch(() => [] as SlackChannel[]);
    return list.find((c) => c.id === r) ?? { id: r, name: r };
  }
  const name = r.replace(/^[#@]/, '').toLowerCase();
  const list = await listChannels(workspaceId);
  const hit = list.find((c) => c.name.toLowerCase() === name) ?? list.find((c) => c.kind === 'dm' && c.name.toLowerCase().includes(name));
  if (!hit) throw new HttpError(404, `No Slack conversation named "${ref}" (only channels you are a member of are visible)`);
  return hit;
}

/* ─────────────── messages ─────────────── */

interface SMsg {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  permalink?: string;
  channel?: { id: string; name?: string };
  files?: { name?: string; title?: string }[];
  attachments?: { fallback?: string; text?: string }[];
}

const tsToIso = (ts: string) => new Date(Math.round(Number(ts) * 1000)).toISOString();

/** replace <@U123> mentions with @name, <#C1|name> with #name and <url|label> with label (url) */
export function renderSlackText(text: string, users: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `@${users.get(id) ?? label ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `#${label || id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, label?: string) => label ?? '@group')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function mentionIds(text: string): string[] {
  return [...text.matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]);
}

function toMessage(ws: SlackWorkspace, channelId: string, m: SMsg, users: Map<string, string>): SlackMessage {
  let text = m.text ?? '';
  if (!text && m.attachments?.length) text = m.attachments.map((a) => a.fallback || a.text || '').join('\n');
  if (m.files?.length) text += `${text ? '\n' : ''}${m.files.map((f) => `[file: ${f.title || f.name || 'attachment'}]`).join(' ')}`;
  const msg: SlackMessage = {
    ts: m.ts,
    channelId,
    workspaceId: ws.id,
    user: (m.user && users.get(m.user)) || m.username || m.bot_profile?.name || m.user || 'unknown',
    text: renderSlackText(text, users),
    date: tsToIso(m.ts),
  };
  if (m.user) msg.userId = m.user;
  if (m.thread_ts) msg.threadTs = m.thread_ts;
  if (m.reply_count) msg.replyCount = m.reply_count;
  if (m.permalink) msg.permalink = m.permalink;
  return msg;
}

/** recent channel history, oldest → newest */
export async function channelHistory(workspaceId: string | undefined, channelId: string, limit = 50): Promise<SlackMessage[]> {
  const ws = resolveWorkspace(workspaceId);
  const r = await wsCall<{ messages: SMsg[] }>(ws, 'conversations.history', { channel: channelId, limit: Math.max(1, Math.min(200, limit)) });
  const msgs = (r.messages ?? []).filter((m) => !m.subtype || !['channel_join', 'channel_leave'].includes(m.subtype));
  const users = await resolveUsers(ws, msgs.flatMap((m) => [m.user ?? '', ...mentionIds(m.text ?? '')]));
  return msgs.map((m) => toMessage(ws, channelId, m, users)).reverse();
}

/** thread replies (parent first) */
export async function threadReplies(workspaceId: string | undefined, channelId: string, threadTs: string, limit = 100): Promise<SlackMessage[]> {
  const ws = resolveWorkspace(workspaceId);
  const r = await wsCall<{ messages: SMsg[] }>(ws, 'conversations.replies', { channel: channelId, ts: threadTs, limit: Math.min(200, limit) });
  const msgs = r.messages ?? [];
  const users = await resolveUsers(ws, msgs.flatMap((m) => [m.user ?? '', ...mentionIds(m.text ?? '')]));
  return msgs.map((m) => toMessage(ws, channelId, m, users));
}

export async function searchMessages(workspaceId: string | undefined, query: string, count = 20): Promise<SlackMessage[]> {
  const ws = resolveWorkspace(workspaceId);
  if (!query?.trim()) throw new HttpError(400, 'Search query is required');
  if (ws.tokenType === 'bot') {
    throw new HttpError(400, `Slack search needs a user token (xoxp-…); workspace ${ws.name} is connected with a bot token. Reconnect it with a User OAuth Token that has the search:read scope.`);
  }
  const r = await wsCall<{ messages?: { matches?: SMsg[] } }>(ws, 'search.messages', {
    query,
    count: Math.max(1, Math.min(100, count)),
    sort: 'timestamp',
    sort_dir: 'desc',
  });
  const matches = r.messages?.matches ?? [];
  const users = await resolveUsers(ws, matches.flatMap((m) => [m.user ?? '', ...mentionIds(m.text ?? '')]));
  return matches.map((m) => toMessage(ws, m.channel?.id ?? '', m, users));
}

export async function postMessage(workspaceId: string | undefined, channelId: string, text: string, threadTs?: string): Promise<SlackMessage> {
  const ws = resolveWorkspace(workspaceId);
  if (!text?.trim()) throw new HttpError(400, 'Message text is required');
  if (!channelId?.trim()) throw new HttpError(400, 'channelId is required');
  const r = await wsCall<{ channel: string; ts: string; message?: SMsg }>(ws, 'chat.postMessage', {
    channel: channelId,
    text,
    thread_ts: threadTs,
  });
  const users = await resolveUsers(ws, [r.message?.user ?? '']);
  activity('SLK', `Posted to ${ws.name}/${channelId}: ${text.slice(0, 80)}`);
  changed('slack');
  return toMessage(ws, r.channel, { ts: r.ts, text, thread_ts: threadTs, ...r.message }, users);
}

/** called once at startup */
export function initSlack(): void {
  const n = listWorkspaces().length;
  if (n) console.log(`[slack] ${n} workspace(s) loaded`);
}
