/**
 * MCP client manager: one live connection per enabled server (stdio child process, Streamable HTTP, or SSE).
 * Connections retry with backoff (3 quick retries, then status 'error'); a dropped connection reconnects the same way.
 * Every status/tool change bumps `mcpGeneration()` (tool cache key) and broadcasts changed('mcp').
 */
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { activity, changed } from '../kernel.ts';
import { CORE_VERSION } from '../services/meta.ts';
import { getConfig, getSecrets, listConfigs, type McpServerConfig } from './store.ts';

export type McpStatus = 'connected' | 'connecting' | 'error' | 'disabled';

export interface McpConn {
  id: string;
  status: McpStatus;
  error?: string;
  client?: Client;
  tools: Tool[];
  serverInfo?: { name: string; version: string };
  instructions?: string;
  logs: string[];
  calls: number;
  connectedAt?: string;
  /** set when an 'http' server only answered over legacy SSE */
  usedSse?: boolean;
  attempt: number;
  retryTimer?: NodeJS.Timeout;
  /** bumps on every (re)connect: callbacks from stale clients are ignored */
  epoch: number;
  closing: boolean;
}

const MAX_LOG_LINES = 200;
const QUICK_RETRIES = 3;
const CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;

const conns = new Map<string, McpConn>();
let generation = 0;

export const mcpGeneration = (): number => generation;
export const getConn = (id: string): McpConn | undefined => conns.get(id);

function bump(): void {
  generation++;
  changed('mcp');
}

function pushLog(c: McpConn, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    c.logs.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
  }
  if (c.logs.length > MAX_LOG_LINES) c.logs.splice(0, c.logs.length - MAX_LOG_LINES);
}

const expandHome = (p: string | undefined): string | undefined =>
  p && (p === '~' || p.startsWith('~/')) ? homedir() + p.slice(1) : p;

function safeEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const k of ['LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'NODE_EXTRA_CA_CERTS', 'NVM_DIR', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA']) {
    const v = process.env[k];
    if (v && !env[k]) env[k] = v;
  }
  if (!env.PATH && process.env.PATH) env.PATH = process.env.PATH;
  if (!env.HOME) env.HOME = homedir();
  return { ...env, ...extra };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message || e.name : String(e);
}

function buildTransport(cfg: McpServerConfig, c: McpConn, kind: 'stdio' | 'http' | 'sse'): Transport {
  const sec = getSecrets(cfg.id);
  if (kind === 'stdio') {
    const t = new StdioClientTransport({
      command: expandHome(cfg.command!)!,
      args: cfg.args ?? [],
      cwd: expandHome(cfg.cwd),
      env: safeEnv(sec.env),
      stderr: 'pipe',
    });
    t.stderr?.on('data', (d: Buffer) => pushLog(c, d.toString('utf8')));
    return t;
  }
  const url = new URL(cfg.url!);
  const requestInit: RequestInit = { headers: { ...sec.headers } };
  if (kind === 'http') return new StreamableHTTPClientTransport(url, { requestInit });
  // SSE: the initial GET uses eventSourceInit; attach headers there too
  return new SSEClientTransport(url, {
    requestInit,
    eventSourceInit: {
      fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...sec.headers } }),
    },
  });
}

function isHttpNotSupported(e: unknown): boolean {
  if (e instanceof StreamableHTTPError && (e.code === 404 || e.code === 405)) return true;
  const m = errMsg(e);
  return /\b(404|405)\b/.test(m);
}

async function listAllTools(client: Client): Promise<Tool[]> {
  if (!client.getServerCapabilities()?.tools) return [];
  const out: Tool[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
    out.push(...r.tools);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

async function openClient(cfg: McpServerConfig, c: McpConn, epoch: number): Promise<Client> {
  const attemptWith = async (kind: 'stdio' | 'http' | 'sse'): Promise<Client> => {
    const client = new Client({ name: 'monarch', version: CORE_VERSION }, { capabilities: {} });
    client.onerror = (e) => {
      if (c.epoch === epoch) pushLog(c, `[monarch] transport error: ${errMsg(e)}`);
    };
    const transport = buildTransport(cfg, c, kind);
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
    return client;
  };
  if (cfg.transport !== 'http') return attemptWith(cfg.transport);
  try {
    return await attemptWith('http');
  } catch (e) {
    if (!isHttpNotSupported(e)) throw e;
    pushLog(c, `[monarch] Streamable HTTP failed (${errMsg(e)}) — trying legacy SSE`);
    const client = await attemptWith('sse');
    c.usedSse = true;
    pushLog(c, '[monarch] connected over legacy SSE (server does not support Streamable HTTP)');
    return client;
  }
}

async function refreshTools(c: McpConn, epoch: number): Promise<void> {
  if (!c.client || c.epoch !== epoch) return;
  try {
    const tools = await listAllTools(c.client);
    if (c.epoch !== epoch) return;
    c.tools = tools;
    bump();
  } catch (e) {
    pushLog(c, `[monarch] tools/list failed: ${errMsg(e)}`);
  }
}

function ensureConn(id: string): McpConn {
  let c = conns.get(id);
  if (!c) {
    c = { id, status: 'disabled', tools: [], logs: [], calls: 0, attempt: 0, epoch: 0, closing: false };
    conns.set(id, c);
  }
  return c;
}

async function connect(id: string): Promise<void> {
  const cfg = getConfig(id);
  const c = ensureConn(id);
  if (!cfg || !cfg.enabled) return;
  const epoch = ++c.epoch;
  c.closing = false;
  c.status = 'connecting';
  c.error = undefined;
  c.usedSse = false;
  bump();
  let client: Client;
  try {
    client = await openClient(cfg, c, epoch);
  } catch (e) {
    if (c.epoch !== epoch) return;
    onFailure(c, epoch, `connect failed: ${errMsg(e)}`);
    return;
  }
  if (c.epoch !== epoch) {
    await client.close().catch(() => {});
    return;
  }
  c.client = client;
  client.onclose = () => {
    if (c.epoch !== epoch || c.closing) return;
    c.client = undefined;
    onFailure(c, epoch, 'connection closed');
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    pushLog(c, '[monarch] tools/list_changed → refreshing');
    await refreshTools(c, epoch);
  });
  try {
    c.tools = await listAllTools(client);
  } catch (e) {
    pushLog(c, `[monarch] tools/list failed: ${errMsg(e)}`);
    c.tools = [];
  }
  if (c.epoch !== epoch) return;
  const info = client.getServerVersion();
  c.serverInfo = info ? { name: info.name, version: info.version } : undefined;
  c.instructions = client.getInstructions();
  c.status = 'connected';
  c.connectedAt = new Date().toISOString();
  c.attempt = 0;
  activity('SYS', `MCP ${cfg.name}: connected${c.usedSse ? ' (SSE fallback)' : ''} — ${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}`);
  bump();
}

function onFailure(c: McpConn, epoch: number, msg: string): void {
  const cfg = getConfig(c.id);
  pushLog(c, `[monarch] ${msg}`);
  const old = c.client;
  c.client = undefined;
  if (old) void old.close().catch(() => {});
  if (!cfg || !cfg.enabled) return;
  if (c.attempt < QUICK_RETRIES) {
    const delay = 1000 * 2 ** c.attempt;
    c.attempt++;
    c.status = 'connecting';
    c.error = `${msg} — retry ${c.attempt}/${QUICK_RETRIES} in ${delay / 1000}s`;
    bump();
    clearTimeout(c.retryTimer);
    c.retryTimer = setTimeout(() => {
      if (c.epoch === epoch) void connect(c.id);
    }, delay);
    c.retryTimer.unref?.();
    return;
  }
  c.status = 'error';
  c.error = msg;
  c.tools = [];
  activity('SYS', `MCP ${cfg.name}: ${msg}`, 'error');
  bump();
}

async function disconnect(c: McpConn): Promise<void> {
  c.epoch++;
  c.closing = true;
  clearTimeout(c.retryTimer);
  const old = c.client;
  c.client = undefined;
  c.tools = [];
  c.connectedAt = undefined;
  if (old) await old.close().catch(() => {});
}

/** (re)connect a server from scratch (resets the retry budget); disabled servers are just stopped */
export async function restartServer(id: string): Promise<void> {
  const c = ensureConn(id);
  await disconnect(c);
  c.attempt = 0;
  const cfg = getConfig(id);
  if (!cfg?.enabled) {
    c.status = 'disabled';
    c.error = undefined;
    bump();
    return;
  }
  await connect(id);
}

export async function stopServer(id: string, forget = false): Promise<void> {
  const c = conns.get(id);
  if (!c) return;
  await disconnect(c);
  c.status = 'disabled';
  if (forget) conns.delete(id);
  bump();
}

/** connect every enabled server in the background (never blocks startup) */
export function startMcp(): void {
  for (const cfg of listConfigs()) {
    const c = ensureConn(cfg.id);
    if (!cfg.enabled) c.status = 'disabled';
    else void connect(cfg.id).catch((e) => pushLog(c, `[monarch] ${errMsg(e)}`));
  }
}

export async function stopMcp(): Promise<void> {
  await Promise.all([...conns.values()].map((c) => disconnect(c)));
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

/** call a server tool; result content flattened to text (images/resources → placeholders) */
export async function callMcpTool(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (text: string) => void } = {},
): Promise<McpCallResult> {
  const c = conns.get(id);
  const cfg = getConfig(id);
  if (!cfg) throw new Error(`MCP server "${id}" is not configured`);
  if (!c?.client || c.status !== 'connected') throw new Error(`MCP server "${cfg.name}" is not connected (${c?.status ?? 'disabled'}${c?.error ? `: ${c.error}` : ''})`);
  c.calls++;
  const r = await c.client.callTool({ name: tool, arguments: args }, undefined, {
    signal: opts.signal,
    timeout: opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    resetTimeoutOnProgress: true,
    onprogress: opts.onProgress
      ? (p) => opts.onProgress!(p.message ?? (p.total ? `${p.progress}/${p.total}` : String(p.progress)))
      : undefined,
  });
  changed('mcp'); // call counter
  return { text: flattenContent(r), isError: r.isError === true };
}

function flattenContent(r: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = Array.isArray(r.content) ? (r.content as Record<string, any>[]) : [];
  for (const p of content) {
    switch (p?.type) {
      case 'text':
        parts.push(String(p.text ?? ''));
        break;
      case 'image':
        parts.push(`[image${p.mimeType ? ` ${p.mimeType}` : ''}]`);
        break;
      case 'audio':
        parts.push(`[audio${p.mimeType ? ` ${p.mimeType}` : ''}]`);
        break;
      case 'resource': {
        const res = p.resource ?? {};
        parts.push(typeof res.text === 'string' ? `[resource ${res.uri}]\n${res.text}` : `[resource ${res.uri ?? ''}]`);
        break;
      }
      case 'resource_link':
        parts.push(`[resource ${p.uri ?? ''}${p.name ? ` (${p.name})` : ''}]`);
        break;
      default:
        parts.push(`[${p?.type ?? 'content'}]`);
    }
  }
  if (!parts.length && r.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(r.structuredContent, null, 2));
    } catch {
      /* ignore */
    }
  }
  if (!parts.length && 'toolResult' in r) parts.push(typeof r.toolResult === 'string' ? r.toolResult : JSON.stringify(r.toolResult));
  return parts.join('\n');
}
