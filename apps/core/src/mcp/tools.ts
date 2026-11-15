/**
 * Live ToolDefs for connected MCP servers + the public McpServer view.
 * Name: mcp_<serverId>_<tool>, sanitized to [a-z0-9_], ≤ 64 chars, deduped (core/extension tool names win).
 * Risk: toolRisks[tool] ?? (annotations.readOnlyHint && the user never set a server risk ? 'safe' : server risk).
 */
import type { McpServer, McpToolInfo, ToolRisk } from '@monarch/shared';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { type ToolDef } from '../kernel.ts';
import { zodFromJsonSchema } from '../extensions/tooldefs.ts';
import { extensionToolDefs } from '../extensions/index.ts';
import { tools as system } from '../tools/system.ts';
import { tools as productivity } from '../tools/productivity.ts';
import { tools as web } from '../tools/web.ts';
import { tools as coding } from '../tools/coding.ts';
import { tools as mail } from '../tools/mail.ts';
import { tools as slack } from '../tools/slack.ts';
import { tools as memory } from '../tools/memory.ts';
// cycles (evolve/delegate → … → tools/index → mcp): only read at call time
import { tools as evolve } from '../tools/evolve.ts';
import { tools as delegate } from '../tools/delegate.ts';
import { callMcpTool, getConn, mcpGeneration } from './manager.ts';
import { getSecrets, listConfigs, type McpServerConfig } from './store.ts';

const MAX_NAME = 64;

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function baseName(serverId: string, tool: string): string {
  const n = `mcp_${sanitize(serverId)}_${sanitize(tool) || 'tool'}`;
  return n.length > MAX_NAME ? n.slice(0, MAX_NAME).replace(/_$/, '') : n;
}

function reservedNames(): Set<string> {
  const s = new Set<string>();
  for (const list of [system, productivity, web, coding, mail, slack, memory, evolve, delegate]) for (const t of list ?? []) s.add(t.name);
  try {
    for (const t of extensionToolDefs()) s.add(t.name);
  } catch {
    /* extensions not ready */
  }
  return s;
}

function unique(want: string, taken: Set<string>): string {
  if (!taken.has(want)) return want;
  for (let i = 2; ; i++) {
    const suf = `_${i}`;
    const n = `${want.slice(0, MAX_NAME - suf.length)}${suf}`;
    if (!taken.has(n)) return n;
  }
}

export function toolRisk(cfg: McpServerConfig, t: Tool): ToolRisk {
  const o = cfg.toolRisks[t.name];
  if (o) return o;
  if (!cfg.riskSet && t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true) return 'safe';
  return cfg.risk;
}

interface Entry {
  cfg: McpServerConfig;
  tool: Tool;
  fullName: string;
}

let cache: { key: string; entries: Map<string, Entry[]>; defs: ToolDef[] } | null = null;

function cacheKey(): string {
  // configs are small; include them so risk/disable/alwaysLoad edits invalidate the cache
  return `${mcpGeneration()}|${JSON.stringify(listConfigs())}`;
}

function build(): NonNullable<typeof cache> {
  const key = cacheKey();
  if (cache && cache.key === key) return cache;
  const taken = reservedNames();
  const entries = new Map<string, Entry[]>();
  const defs: ToolDef[] = [];
  for (const cfg of listConfigs()) {
    const c = getConn(cfg.id);
    const list: Entry[] = [];
    entries.set(cfg.id, list);
    if (!cfg.enabled || !c || c.status !== 'connected') {
      // still name the tools we last saw (for the UI) without registering them
      continue;
    }
    for (const tool of c.tools) {
      const fullName = unique(baseName(cfg.id, tool.name), taken);
      taken.add(fullName);
      list.push({ cfg, tool, fullName });
      if (cfg.disabledTools.includes(tool.name)) continue;
      defs.push(buildDef(cfg, tool, fullName));
    }
  }
  cache = { key, entries, defs };
  return cache;
}

function buildDef(cfg: McpServerConfig, tool: Tool, fullName: string): ToolDef {
  const desc = (tool.description ?? tool.title ?? tool.name).trim();
  return {
    name: fullName,
    description: `[${cfg.name}] ${desc}`.slice(0, 2000),
    risk: toolRisk(cfg, tool),
    schema: zodFromJsonSchema((tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>),
    tag: 'NET',
    loading: cfg.alwaysLoad ? 'always' : 'deferred',
    group: `mcp:${cfg.id}`,
    keywords: ['mcp', cfg.id, cfg.name.toLowerCase(), tool.name, ...(tool.title ? [tool.title.toLowerCase()] : [])],
    summarize: (input) => {
      let args = '';
      try {
        args = JSON.stringify(input);
      } catch {
        /* ignore */
      }
      return `${cfg.name}: ${tool.name}${args && args !== '{}' ? ` ${args.length > 100 ? `${args.slice(0, 100)}…` : args}` : ''}`;
    },
    run: async (input, ctx) => {
      const r = await callMcpTool(cfg.id, tool.name, input as Record<string, unknown>, {
        signal: ctx.signal,
        onProgress: (p) => ctx.progress(p),
      });
      if (r.isError) throw new Error(r.text || `${tool.name} failed`);
      return r.text || 'ok';
    },
  };
}

/** sync + live: one ToolDef per enabled tool of every connected MCP server (cached until anything changes) */
export function mcpToolDefs(): ToolDef[] {
  return build().defs;
}

export function publicServer(cfg: McpServerConfig): McpServer {
  const c = getConn(cfg.id);
  const sec = getSecrets(cfg.id);
  const entries = build().entries.get(cfg.id) ?? [];
  const tools: McpToolInfo[] = entries.map((e) => ({
    name: e.tool.name,
    fullName: e.fullName,
    description: e.tool.description ?? '',
    risk: toolRisk(cfg, e.tool),
    enabled: !cfg.disabledTools.includes(e.tool.name),
    inputSchema: e.tool.inputSchema,
  }));
  return {
    id: cfg.id,
    name: cfg.name,
    enabled: cfg.enabled,
    transport: cfg.transport,
    ...(cfg.command !== undefined ? { command: cfg.command } : {}),
    ...(cfg.args !== undefined ? { args: cfg.args } : {}),
    ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
    ...(cfg.url !== undefined ? { url: cfg.url } : {}),
    envKeys: Object.keys(sec.env),
    headerKeys: Object.keys(sec.headers),
    risk: cfg.risk,
    toolRisks: cfg.toolRisks,
    disabledTools: cfg.disabledTools,
    alwaysLoad: cfg.alwaysLoad,
    status: !cfg.enabled ? 'disabled' : (c?.status === 'disabled' ? 'connecting' : c?.status) ?? 'connecting',
    ...(c?.error ? { error: c.error } : {}),
    ...(c?.serverInfo ? { serverInfo: c.serverInfo } : {}),
    ...(c?.instructions ? { instructions: c.instructions } : {}),
    tools,
    logs: [...(c?.logs ?? [])],
    calls: c?.calls ?? 0,
    ...(c?.connectedAt && c.status === 'connected' ? { connectedAt: c.connectedAt } : {}),
  };
}

export function publicServers(): McpServer[] {
  return listConfigs().map(publicServer);
}
