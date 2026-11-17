/** MCP servers (Monarch as an MCP client) — see protocol.ts "MCP servers" + /api/mcp/* lines. */
import type { Hono } from 'hono';
import type { McpServerInput } from '@monarch/shared';
import { MCP_OAUTH_PATH } from '../mcp/oauth.ts';
import { readJson } from '../services/http.ts';
import {
  addMcpServer,
  completeMcpAuth,
  signOutMcp,
  startMcpAuth,
  importMcpServers,
  listMcpServers,
  patchMcpServer,
  reconnectMcpServer,
  removeMcpServer,
  testMcpTool,
} from '../mcp/index.ts';

export function register(app: Hono): void {
  app.get('/api/mcp/servers', (c) => c.json(listMcpServers()));
  app.post('/api/mcp/servers', async (c) => c.json(await addMcpServer(await readJson<McpServerInput>(c))));
  app.patch('/api/mcp/servers/:id', async (c) => c.json(await patchMcpServer(c.req.param('id'), await readJson<Partial<McpServerInput>>(c))));
  app.delete('/api/mcp/servers/:id', async (c) => c.json(await removeMcpServer(c.req.param('id'))));
  app.post('/api/mcp/servers/:id/reconnect', async (c) => c.json(await reconnectMcpServer(c.req.param('id'))));
  app.post('/api/mcp/servers/:id/auth', async (c) => c.json(await startMcpAuth(c.req.param('id'))));
  app.delete('/api/mcp/servers/:id/auth', async (c) => c.json(await signOutMcp(c.req.param('id'))));
  app.get(MCP_OAUTH_PATH, async (c) => {
    const q = c.req.query();
    if (q.error) return c.html(page('Sign-in cancelled', `${q.error}${q.error_description ? `: ${q.error_description}` : ''}`), 400);
    if (!q.code || !q.state) return c.html(page('Sign-in failed', 'Missing code or state.'), 400);
    try {
      const s = await completeMcpAuth(q.state, q.code);
      return c.html(page(`${s.name} connected`, s.status === 'connected' ? `${s.tools.length} tools available. You can close this tab and return to Monarch.` : `Signed in. Status: ${s.status}${s.error ? ` — ${s.error}` : ''}. You can close this tab.`));
    } catch (e) {
      return c.html(page('Sign-in failed', e instanceof Error ? e.message : String(e)), 400);
    }
  });
  app.post('/api/mcp/servers/:id/tools/:tool/test', async (c) => {
    const body = await readJson<{ args?: unknown }>(c).catch(() => ({}) as { args?: unknown });
    return c.json(await testMcpTool(c.req.param('id'), c.req.param('tool'), body.args ?? {}));
  });
  app.post('/api/mcp/import', async (c) => {
    const body = await readJson<{ json?: unknown }>(c);
    return c.json(await importMcpServers(body.json ?? body));
  });
}

const esc = (t: string): string => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="background:#121213;color:#F4F4F6;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:440px;text-align:center"><h2 style="font-weight:500">${esc(title)}</h2><p style="color:#9E9EA4">${esc(body)}</p></div>`;
}
