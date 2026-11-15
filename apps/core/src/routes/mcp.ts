/** MCP servers (Monarch as an MCP client) — see protocol.ts "MCP servers" + /api/mcp/* lines. */
import type { Hono } from 'hono';
import type { McpServerInput } from '@monarch/shared';
import { readJson } from '../services/http.ts';
import {
  addMcpServer,
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
  app.post('/api/mcp/servers/:id/tools/:tool/test', async (c) => {
    const body = await readJson<{ args?: unknown }>(c).catch(() => ({}) as { args?: unknown });
    return c.json(await testMcpTool(c.req.param('id'), c.req.param('tool'), body.args ?? {}));
  });
  app.post('/api/mcp/import', async (c) => {
    const body = await readJson<{ json?: unknown }>(c);
    return c.json(await importMcpServers(body.json ?? body));
  });
}
