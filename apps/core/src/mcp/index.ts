/** MCP client integration: user-configured MCP servers whose tools are exposed to both engines. */
import type { McpServer, McpServerInput } from '@monarch/shared';
import { HttpError, activity, changed } from '../kernel.ts';
import { callMcpTool, restartServer, startMcp, stopMcp, stopServer } from './manager.ts';
import { createConfig, deleteConfig, getConfig, parseImport, updateConfig } from './store.ts';
import { publicServer, publicServers } from './tools.ts';

export { mcpToolDefs } from './tools.ts';
export { startMcp, stopMcp };

export const listMcpServers = (): McpServer[] => publicServers();

function view(id: string): McpServer {
  const cfg = getConfig(id);
  if (!cfg) throw new HttpError(404, `no MCP server "${id}"`);
  return publicServer(cfg);
}

/** wait briefly for a connect so the response usually carries tools; never longer than `ms` */
async function settle(p: Promise<unknown>, ms = 15_000): Promise<void> {
  await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms).unref())]);
}

export async function addMcpServer(input: McpServerInput, opts: { renameOnCollision?: boolean; wait?: boolean } = {}): Promise<McpServer> {
  const cfg = createConfig(input, opts);
  activity('SYS', `MCP server added: ${cfg.name} (${cfg.transport})`);
  const p = restartServer(cfg.id);
  if (opts.wait !== false) await settle(p);
  return view(cfg.id);
}

export async function patchMcpServer(id: string, patch: Partial<McpServerInput>): Promise<McpServer> {
  const before = getConfig(id);
  const { cfg, reconnect } = updateConfig(id, patch);
  if (reconnect || before?.enabled !== cfg.enabled) await settle(restartServer(id));
  else changed('mcp');
  return view(id);
}

export async function removeMcpServer(id: string): Promise<{ ok: true }> {
  const cfg = getConfig(id);
  deleteConfig(id);
  await stopServer(id, true);
  activity('SYS', `MCP server removed: ${cfg?.name ?? id}`);
  return { ok: true };
}

export async function reconnectMcpServer(id: string): Promise<McpServer> {
  if (!getConfig(id)) throw new HttpError(404, `no MCP server "${id}"`);
  await settle(restartServer(id));
  return view(id);
}

export async function testMcpTool(id: string, tool: string, args: unknown): Promise<{ ok: boolean; output: string; durationMs: number }> {
  if (!getConfig(id)) throw new HttpError(404, `no MCP server "${id}"`);
  const t0 = Date.now();
  try {
    const r = await callMcpTool(id, tool, (args && typeof args === 'object' ? args : {}) as Record<string, unknown>);
    return { ok: !r.isError, output: r.text, durationMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e), durationMs: Date.now() - t0 };
  }
}

export async function importMcpServers(json: unknown): Promise<McpServer[]> {
  const inputs = parseImport(json);
  if (!inputs.length) throw new HttpError(400, 'no servers found in the JSON');
  const ids: string[] = [];
  for (const input of inputs) ids.push(createConfig(input, { renameOnCollision: true }).id);
  activity('SYS', `MCP: imported ${ids.length} server${ids.length === 1 ? '' : 's'}`);
  await settle(Promise.all(ids.map((id) => restartServer(id))));
  return ids.map(view);
}
