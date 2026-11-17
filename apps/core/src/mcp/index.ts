/** MCP client integration: user-configured MCP servers whose tools are exposed to both engines. */
import type { McpServer, McpServerInput } from '@monarch/shared';
import { HttpError, activity, changed } from '../kernel.ts';
import { callMcpTool, restartServer, startMcp, stopMcp, stopServer } from './manager.ts';
import { finishOauth, forgetOauth, startOauth } from './oauth.ts';
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
  if (patch.url !== undefined && before?.url && patch.url !== before.url) forgetOauth(id);
  const { cfg, reconnect } = updateConfig(id, patch);
  if (reconnect || before?.enabled !== cfg.enabled) await settle(restartServer(id));
  else changed('mcp');
  return view(id);
}

export async function removeMcpServer(id: string): Promise<{ ok: true }> {
  const cfg = getConfig(id);
  deleteConfig(id);
  forgetOauth(id);
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

/** OAuth sign-in: returns the authorization URL to open (null = already authorized, server reconnected) */
export async function startMcpAuth(id: string): Promise<{ url: string | null; server: McpServer }> {
  const cfg = getConfig(id);
  if (!cfg) throw new HttpError(404, `no MCP server "${id}"`);
  if (cfg.transport === 'stdio' || !cfg.url) throw new HttpError(400, 'OAuth is only for http/sse servers');
  let url: string | null;
  try {
    url = await startOauth(id, cfg.url);
  } catch (e) {
    throw new HttpError(502, `OAuth sign-in could not start: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!url) await settle(restartServer(id));
  return { url, server: view(id) };
}

export async function signOutMcp(id: string): Promise<McpServer> {
  if (!getConfig(id)) throw new HttpError(404, `no MCP server "${id}"`);
  forgetOauth(id);
  activity('SYS', `MCP ${getConfig(id)!.name}: signed out`);
  await settle(restartServer(id));
  return view(id);
}

/** OAuth redirect target: exchange the code, then reconnect */
export async function completeMcpAuth(state: string, code: string): Promise<McpServer> {
  const id = await finishOauth(state, code, (sid) => getConfig(sid)?.url);
  activity('SYS', `MCP ${getConfig(id)?.name ?? id}: signed in`);
  await settle(restartServer(id));
  return view(id);
}
