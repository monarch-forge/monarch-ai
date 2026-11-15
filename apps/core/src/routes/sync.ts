/** Sync routes: encrypted backup of all Monarch data to a private git remote (see services/sync.ts). */
import type { Hono } from 'hono';
import { connect, detectProviders, history, pull, push, scheduleRestart, setPassphrase, status } from '../services/sync.ts';

export function register(app: Hono): void {
  app.get('/api/sync/providers', async (c) => c.json(await detectProviders()));
  app.get('/api/sync/status', (c) => c.json(status()));
  app.put('/api/sync/passphrase', async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    return c.json(setPassphrase(body?.passphrase));
  });
  app.post('/api/sync/connect', async (c) => c.json(await connect()));
  app.post('/api/sync/push', async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    return c.json(await push({ force: body?.force === true }));
  });
  app.post('/api/sync/pull', async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const r = await pull({ commit: typeof body?.commit === 'string' && body.commit ? body.commit : undefined });
    scheduleRestart(r.restoreNow);
    return c.json({ restored: true, restarting: true });
  });
  app.get('/api/sync/history', async (c) => c.json(await history(Number(c.req.query('limit')) || 30)));
}
