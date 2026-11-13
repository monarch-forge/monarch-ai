/** HTTP (Hono) + WebSocket (ws) server on one node http.Server. */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAdaptorServer } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientCommand, ServerEvent } from '@monarch/shared';
import { bus, HttpError } from './kernel.ts';
import { registerRoutes } from './routes/index.ts';
import { currentPhase, handleClientCommand } from './agent/orchestrator.ts';
import { healthInfo } from './services/meta.ts';
import { lastMetrics, setClientCount } from './services/metrics.ts';

const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
];
const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ORIGINS,
  ...(process.env.MONARCH_EXTRA_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]);

/** requests without an Origin header (curl, same-origin navigations, Tauri http plugin) are allowed */
export function originAllowed(origin: string | undefined | null): boolean {
  return !origin || ALLOWED_ORIGINS.has(origin);
}

export function createApp(): Hono {
  const app = new Hono();

  // Reject cross-site requests outright: CORS alone does not stop a foreign page from *sending* a POST.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (!originAllowed(origin)) return c.json({ error: `origin ${origin} not allowed` }, 403);
    await next();
  });
  app.use(
    '*',
    cors({
      origin: (origin) => (origin && ALLOWED_ORIGINS.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  app.get('/api/health', (c) => c.json(healthInfo()));
  registerRoutes(app);

  app.notFound((c) => c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    const st = (err as unknown as { status?: unknown }).status;
    const status = typeof st === 'number' && st >= 400 && st < 600 ? st : 500;
    if (status >= 500) console.error(`[http] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: err.message || 'Internal error' }, status as 500);
  });
  return app;
}

/* ─────────────── WebSocket ─────────────── */

const clients = new Set<WebSocket>();
const alive = new WeakMap<WebSocket, boolean>();

function send(ws: WebSocket, ev: ServerEvent | string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(typeof ev === 'string' ? ev : JSON.stringify(ev));
  } catch (e) {
    console.error('[ws] send failed:', e);
  }
}

function attachWebSocket(server: Server): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!originAllowed(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    alive.set(ws, true);
    setClientCount(clients.size);
    send(ws, { type: 'hello', health: healthInfo(), phase: safePhase() });
    const m = lastMetrics();
    if (m) send(ws, { type: 'metrics', metrics: m });

    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(data.toString()) as ClientCommand;
      } catch {
        return;
      }
      if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return;
      if (cmd.type === 'ping') {
        send(ws, { type: 'pong', t: cmd.t });
        return;
      }
      try {
        handleClientCommand(cmd);
      } catch (e) {
        console.error(`[ws] command ${cmd.type} failed:`, e);
      }
    });
    const drop = () => {
      clients.delete(ws);
      setClientCount(clients.size);
    };
    ws.on('close', drop);
    ws.on('error', (e) => {
      console.warn('[ws] client error:', e.message);
      drop();
    });
  });

  const offBus = bus.onServerEvent((ev) => {
    if (!clients.size) return;
    const frame = JSON.stringify(ev);
    for (const ws of clients) {
      // skip high-frequency metrics for clients that are not keeping up
      if (ev.type === 'metrics' && ws.bufferedAmount > 1024 * 1024) continue;
      send(ws, frame);
    }
  });

  // heartbeat: terminate clients that stopped answering pings
  const hb = setInterval(() => {
    for (const ws of clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* closed */
      }
    }
    setClientCount(clients.size);
  }, 30_000);
  hb.unref();

  return {
    close() {
      clearInterval(hb);
      offBus();
      for (const ws of clients) ws.close(1001, 'core shutting down');
      clients.clear();
      setClientCount(0);
      wss.close();
    },
  };
}

function safePhase() {
  try {
    return currentPhase();
  } catch {
    return 'idle' as const;
  }
}

export interface CoreServer {
  server: Server;
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

export function createServer(): CoreServer {
  const app = createApp();
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const ws = attachWebSocket(server);
  return {
    server,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        const onError = (e: Error) => reject(e);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });
    },
    close() {
      ws.close();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
