/**
 * Core-C routes: google/*, mail/*, slack/*, memory/* (+ the non-/api Google OAuth loopback callback).
 * Shapes: packages/shared/src/protocol.ts. Errors → { error } with 400/404/409/502.
 */
import type { Context, Hono } from 'hono';
import type { MailDraft } from '@monarch/shared';
import { HttpError } from '../kernel.ts';
import {
  GOOGLE_REDIRECT_PATH,
  createDraft,
  getGoogleClientConfig,
  getThread,
  googleCallbackPage,
  handleGoogleOAuthCallback,
  listGoogleAccounts,
  listThreads,
  modifyThread,
  removeGoogleAccount,
  sendMail,
  setGoogleClientConfig,
  startGoogleConnectFlow,
} from '../integrations/google/index.ts';
import {
  addWorkspace,
  channelHistory,
  listChannels,
  listWorkspaces,
  postMessage,
  removeWorkspace,
  resolveWorkspace,
  searchMessages,
} from '../integrations/slack/index.ts';
import { deleteNote, getGraph, getNote, putNote, searchNotes } from '../integrations/memory/index.ts';

type Handler = (c: Context) => Promise<Response> | Response;

function errorResponse(e: unknown): Response {
  const status = e instanceof HttpError ? e.status : 500;
  const message = e instanceof Error ? e.message : String(e);
  if (status >= 500) console.error('[integrations]', message);
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const h =
  (fn: Handler): Handler =>
  async (c) => {
    try {
      return await fn(c);
    } catch (e) {
      return errorResponse(e);
    }
  };

async function jsonBody<T = Record<string, unknown>>(c: Context): Promise<T> {
  let v: unknown;
  try {
    v = await c.req.json();
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Request body must be a JSON object');
  return v as T;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
function intParam(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? Math.max(min, Math.min(max, Math.trunc(n))) : def;
}

function draftFrom(b: Record<string, unknown>): MailDraft {
  const accountId = str(b.accountId);
  const to = str(b.to);
  if (!accountId) throw new HttpError(400, 'accountId is required');
  if (!to?.trim()) throw new HttpError(400, 'to is required');
  if (typeof b.body !== 'string') throw new HttpError(400, 'body (string) is required');
  return {
    accountId,
    to,
    cc: str(b.cc),
    subject: str(b.subject) ?? '',
    body: b.body,
    threadId: str(b.threadId),
    inReplyTo: str(b.inReplyTo),
  };
}

export function register(app: Hono): void {
  /* ─────────────── google ─────────────── */

  app.get('/api/google/client', h((c) => c.json(getGoogleClientConfig())));

  app.put(
    '/api/google/client',
    h(async (c) => {
      const b = await jsonBody(c);
      return c.json(setGoogleClientConfig(str(b.clientId) ?? '', str(b.clientSecret) ?? ''));
    }),
  );

  app.get('/api/google/accounts', h((c) => c.json(listGoogleAccounts())));

  app.post('/api/google/accounts/connect', h((c) => c.json(startGoogleConnectFlow())));

  app.delete(
    '/api/google/accounts/:id',
    h(async (c) => {
      const ok = await removeGoogleAccount(c.req.param('id') ?? '');
      if (!ok) throw new HttpError(404, 'Google account not found');
      return c.json({ ok: true });
    }),
  );

  // OAuth loopback redirect target (not under /api — must match the registered redirect URI exactly)
  app.get(GOOGLE_REDIRECT_PATH, async (c) => {
    try {
      const r = await handleGoogleOAuthCallback({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') });
      return c.html(googleCallbackPage(r.ok, r.message), r.ok ? 200 : 400);
    } catch (e) {
      return c.html(googleCallbackPage(false, (e as Error).message), 500);
    }
  });

  /* ─────────────── mail ─────────────── */

  app.get(
    '/api/mail/threads',
    h(async (c) => {
      const q = c.req.query('q')?.trim() || undefined;
      const labelParam = c.req.query('label');
      const labelIds =
        labelParam === undefined
          ? q
            ? []
            : ['INBOX']
          : labelParam
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s && s.toUpperCase() !== 'ALL');
      return c.json(
        await listThreads({
          accountId: c.req.query('accountId') || undefined,
          q,
          labelIds,
          max: intParam(c.req.query('max'), 30, 1, 100),
        }),
      );
    }),
  );

  app.get(
    '/api/mail/threads/:accountId/:threadId',
    h(async (c) => c.json(await getThread(c.req.param('accountId') ?? '', c.req.param('threadId') ?? ''))),
  );

  app.post(
    '/api/mail/threads/:accountId/:threadId/modify',
    h(async (c) => {
      const b = await jsonBody(c);
      await modifyThread(c.req.param('accountId') ?? '', c.req.param('threadId') ?? '', strArr(b.addLabels), strArr(b.removeLabels));
      return c.json({ ok: true });
    }),
  );

  app.post(
    '/api/mail/send',
    h(async (c) => {
      const r = await sendMail(draftFrom(await jsonBody(c)));
      return c.json({ id: r.id });
    }),
  );

  app.post(
    '/api/mail/drafts',
    h(async (c) => c.json(await createDraft(draftFrom(await jsonBody(c))))),
  );

  /* ─────────────── slack ─────────────── */

  app.get('/api/slack/workspaces', h((c) => c.json(listWorkspaces())));

  app.post(
    '/api/slack/workspaces',
    h(async (c) => {
      const b = await jsonBody(c);
      return c.json(await addWorkspace(str(b.token) ?? ''));
    }),
  );

  app.delete(
    '/api/slack/workspaces/:id',
    h((c) => {
      if (!removeWorkspace(c.req.param('id') ?? '')) throw new HttpError(404, 'Slack workspace not found');
      return c.json({ ok: true });
    }),
  );

  app.get(
    '/api/slack/:workspaceId/channels',
    h(async (c) => {
      const ws = resolveWorkspace(c.req.param('workspaceId'));
      return c.json(await listChannels(ws.id, { refresh: c.req.query('refresh') === '1' }));
    }),
  );

  app.get(
    '/api/slack/:workspaceId/channels/:channelId/messages',
    h(async (c) => {
      const ws = resolveWorkspace(c.req.param('workspaceId'));
      return c.json(await channelHistory(ws.id, c.req.param('channelId') ?? '', intParam(c.req.query('limit'), 50, 1, 200)));
    }),
  );

  app.get(
    '/api/slack/:workspaceId/search',
    h(async (c) => {
      const ws = resolveWorkspace(c.req.param('workspaceId'));
      const q = c.req.query('q')?.trim();
      if (!q) throw new HttpError(400, 'q is required');
      return c.json(await searchMessages(ws.id, q, intParam(c.req.query('count'), 30, 1, 100)));
    }),
  );

  app.post(
    '/api/slack/:workspaceId/post',
    h(async (c) => {
      const ws = resolveWorkspace(c.req.param('workspaceId'));
      const b = await jsonBody(c);
      const channelId = str(b.channelId);
      const text = str(b.text);
      if (!channelId) throw new HttpError(400, 'channelId is required');
      if (!text?.trim()) throw new HttpError(400, 'text is required');
      return c.json(await postMessage(ws.id, channelId, text, str(b.threadTs)));
    }),
  );

  /* ─────────────── memory ─────────────── */

  app.get(
    '/api/memory/notes',
    h(async (c) => c.json(await searchNotes(c.req.query('q'), intParam(c.req.query('limit'), 200, 1, 2000)))),
  );

  app.get('/api/memory/graph', h(async (c) => c.json(await getGraph())));

  // ids are URL-encoded relative paths and may contain "/" (encoded as %2F or raw) — catch-all param
  app.get(
    '/api/memory/notes/:id{.+}',
    h(async (c) => c.json(await getNote(c.req.param('id') ?? ''))),
  );

  app.put(
    '/api/memory/notes/:id{.+}',
    h(async (c) => {
      const b = await jsonBody(c);
      if (typeof b.body !== 'string') throw new HttpError(400, 'body (string) is required');
      const tags = b.tags === undefined ? undefined : strArr(b.tags);
      return c.json(await putNote(c.req.param('id') ?? '', { title: str(b.title), body: b.body, tags, source: 'user' }));
    }),
  );

  app.delete(
    '/api/memory/notes/:id{.+}',
    h(async (c) => {
      await deleteNote(c.req.param('id') ?? '');
      return c.json({ ok: true });
    }),
  );
}
