/** WhatsApp routes: /api/whatsapp/* */
import type { Context, Hono } from 'hono';
import { HttpError } from '../kernel.ts';
import { autoStart, chats, connect, getStatus, logout, markRead, messages, sendText } from '../integrations/whatsapp/index.ts';

type Handler = (c: Context) => Promise<Response> | Response;
const h =
  (fn: Handler): Handler =>
  async (c) => {
    try {
      return await fn(c);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error('[whatsapp]', e);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, status as 500);
    }
  };

async function body(c: Context): Promise<Record<string, unknown>> {
  const v = await c.req.json().catch(() => null);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Request body must be a JSON object');
  return v as Record<string, unknown>;
}

export function register(app: Hono): void {
  autoStart();
  app.get('/api/whatsapp/status', h((c) => c.json(getStatus())));
  app.post('/api/whatsapp/pair', h(async (c) => c.json(await connect())));
  app.post('/api/whatsapp/logout', h(async (c) => (await logout(), c.json({ ok: true }))));
  app.get('/api/whatsapp/chats', h((c) => c.json(chats())));
  app.get(
    '/api/whatsapp/chats/:id/messages',
    h((c) => c.json(messages(c.req.param('id') ?? '', Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))))),
  );
  app.post(
    '/api/whatsapp/chats/:id/send',
    h(async (c) => {
      const text = (await body(c)).text;
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
      return c.json(await sendText(c.req.param('id') ?? '', text));
    }),
  );
  app.post('/api/whatsapp/chats/:id/read', h(async (c) => (await markRead(c.req.param('id') ?? ''), c.json({ ok: true }))));
}
