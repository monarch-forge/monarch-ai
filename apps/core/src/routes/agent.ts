/** Agent routes (Core-B): providers, models, oauth, sessions, approvals. */
import type { Hono } from 'hono';
import type { SessionKind } from '@monarch/shared';
import { HttpError } from '../kernel.ts';
import { abortSession, removeSession } from '../agent/orchestrator.ts';
import { getSession, listSessions, renameSession, toDetail, toSummary } from '../agent/sessions.ts';
import { pendingApprovals } from '../agent/approvals.ts';
import { cancelGoogleFlow } from '../integrations/google/index.ts';
import {
  cancelOAuthFlow,
  deleteProviderKey,
  listAvailableModels,
  listModels,
  listProviders,
  logoutProvider,
  pingProvider,
  setProviderKey,
  startLogin,
  submitOAuthCode,
  discoverCustomModels,
} from '../agent/providers.ts';

async function body(c: { req: { json(): Promise<any> } }): Promise<Record<string, any>> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}

const KINDS: SessionKind[] = ['chat', 'coding', 'automation'];

export function register(app: Hono): void {
  /* providers */
  app.get('/api/providers', async (c) => c.json(await listProviders()));
  app.get('/api/providers/custom/discover', async (c) => c.json(await discoverCustomModels(c.req.query('baseUrl'))));
  app.put('/api/providers/:id/key', async (c) => {
    const b = await body(c);
    return c.json(await setProviderKey(c.req.param('id'), String(b.apiKey ?? '')));
  });
  app.delete('/api/providers/:id/key', async (c) => c.json(await deleteProviderKey(c.req.param('id'))));
  app.post('/api/providers/:id/ping', async (c) => c.json(await pingProvider(c.req.param('id'))));
  app.post('/api/providers/:id/login', (c) => c.json(startLogin(c.req.param('id'))));
  app.delete('/api/providers/:id/login', async (c) => c.json(await logoutProvider(c.req.param('id'))));

  /* oauth paste-code / cancel (pi provider flows; cancel also covers Google account flows) */
  app.post('/api/oauth/:flowId/code', async (c) => {
    const b = await body(c);
    const st = submitOAuthCode(c.req.param('flowId'), String(b.code ?? ''));
    if (!st) throw new HttpError(404, 'Unknown sign-in flow');
    return c.json(st);
  });
  app.post('/api/oauth/:flowId/cancel', (c) => {
    const flowId = c.req.param('flowId');
    let ok = false;
    try {
      ok = cancelGoogleFlow(flowId);
    } catch {
      ok = false;
    }
    if (cancelOAuthFlow(flowId)) ok = true;
    if (!ok) throw new HttpError(404, 'Unknown sign-in flow');
    return c.json({ ok: true });
  });

  /* models */
  app.get('/api/models/available', async (c) => c.json(await listAvailableModels()));
  app.get('/api/models', async (c) => c.json(await listModels(c.req.query('engine') || undefined, c.req.query('provider') || undefined)));

  /* sessions */
  app.get('/api/sessions', (c) => {
    const kind = c.req.query('kind') as SessionKind | undefined;
    if (kind && !KINDS.includes(kind)) throw new HttpError(400, `invalid kind: ${kind}`);
    return c.json(listSessions(kind));
  });
  app.get('/api/sessions/:id', (c) => {
    const r = getSession(c.req.param('id'));
    if (!r) throw new HttpError(404, 'Session not found');
    return c.json(toDetail(r));
  });
  app.patch('/api/sessions/:id', async (c) => {
    const b = await body(c);
    if (typeof b.title !== 'string' || !b.title.trim()) throw new HttpError(400, 'title is required');
    const r = renameSession(c.req.param('id'), b.title);
    if (!r) throw new HttpError(404, 'Session not found');
    return c.json(toSummary(r));
  });
  app.delete('/api/sessions/:id', (c) => {
    if (!removeSession(c.req.param('id'))) throw new HttpError(404, 'Session not found');
    return c.json({ ok: true });
  });
  /** convenience (not in protocol.ts; WS chat.abort is canonical) */
  app.post('/api/sessions/:id/abort', (c) => c.json({ ok: abortSession(c.req.param('id')) }));

  /* approvals */
  app.get('/api/approvals', (c) => c.json(pendingApprovals()));
}
