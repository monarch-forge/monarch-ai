/**
 * MCP server configuration. Non-secret config lives in data/mcp-servers.json; env values and headers
 * (credentials) live in secrets.json under secrets.mcp[serverId] = { env, headers } and never leave the core.
 */
import type { McpServerInput, McpTransport, ToolRisk } from '@monarch/shared';
import { HttpError, dataStore, secrets } from '../kernel.ts';

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  risk: ToolRisk;
  /** true once the user chose a server risk (then MCP readOnlyHint no longer lowers tools to 'safe') */
  riskSet?: boolean;
  toolRisks: Record<string, ToolRisk>;
  disabledTools: string[];
  alwaysLoad: boolean;
  createdAt: string;
}

export interface McpSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

const store = dataStore<McpServerConfig[]>('mcp-servers', []);

export const listConfigs = (): McpServerConfig[] => store.get();
export const getConfig = (id: string): McpServerConfig | undefined => store.get().find((s) => s.id === id);

function secretBag(): Record<string, McpSecrets> {
  const s = secrets.get() as Record<string, any>;
  if (!s.mcp || typeof s.mcp !== 'object') s.mcp = {};
  return s.mcp as Record<string, McpSecrets>;
}
export function getSecrets(id: string): McpSecrets {
  const b = secretBag()[id];
  return { env: { ...(b?.env ?? {}) }, headers: { ...(b?.headers ?? {}) } };
}
function setSecrets(id: string, v: McpSecrets): void {
  secrets.update((s: Record<string, any>) => {
    s.mcp = { ...(s.mcp ?? {}) };
    if (!Object.keys(v.env).length && !Object.keys(v.headers).length) delete s.mcp[id];
    else s.mcp[id] = v;
  });
}
function forgetSecrets(id: string): void {
  secrets.update((s: Record<string, any>) => {
    if (s.mcp) delete s.mcp[id];
  });
}

/* ─────────────── validation ─────────────── */

const RISKS: ToolRisk[] = ['safe', 'sensitive', 'dangerous'];
const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** '' or a mask (only •/* characters) means "keep the stored value" */
export const isKeepValue = (v: unknown): boolean => typeof v !== 'string' || v === '' || /^[•*]+$/.test(v);

export function slugId(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40);
  return s || 'server';
}

function bad(msg: string): never {
  throw new HttpError(400, msg);
}

function strRecord(v: unknown, what: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) bad(`${what} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!k.trim()) bad(`${what}: empty key`);
    out[k] = val === undefined || val === null ? '' : String(val);
  }
  return out;
}

function checkRisk(v: unknown, what: string): ToolRisk {
  if (!RISKS.includes(v as ToolRisk)) bad(`${what} must be one of ${RISKS.join(', ')}`);
  return v as ToolRisk;
}

function validateFinal(c: McpServerConfig): void {
  if (!ID_RE.test(c.id)) bad('id must match [a-z0-9][a-z0-9_-]{0,39}');
  if (!c.name?.trim()) bad('name is required');
  if (!TRANSPORTS.includes(c.transport)) bad(`transport must be one of ${TRANSPORTS.join(', ')}`);
  if (c.transport === 'stdio') {
    if (!c.command?.trim()) bad('command is required for stdio servers');
  } else {
    if (!c.url) bad(`url is required for ${c.transport} servers`);
    let u: URL;
    try {
      u = new URL(c.url);
    } catch {
      bad('url is not a valid URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') bad('url must be http(s)');
  }
}

/** merge a (partial) input onto a config; returns the new config + secrets and whether connection params changed */
function apply(
  base: McpServerConfig,
  baseSecrets: McpSecrets,
  input: Partial<McpServerInput>,
): { cfg: McpServerConfig; sec: McpSecrets; reconnect: boolean } {
  const cfg: McpServerConfig = { ...base, toolRisks: { ...base.toolRisks }, disabledTools: [...base.disabledTools] };
  const sec: McpSecrets = { env: { ...baseSecrets.env }, headers: { ...baseSecrets.headers } };
  let reconnect = false;
  if (input.name !== undefined) cfg.name = String(input.name).trim();
  if (input.enabled !== undefined) cfg.enabled = !!input.enabled;
  if (input.transport !== undefined && input.transport !== cfg.transport) {
    cfg.transport = input.transport;
    reconnect = true;
  }
  if (input.command !== undefined && input.command !== cfg.command) {
    cfg.command = String(input.command).trim() || undefined;
    reconnect = true;
  }
  if (input.args !== undefined) {
    if (!Array.isArray(input.args)) bad('args must be an array of strings');
    const args = input.args.map(String);
    if (JSON.stringify(args) !== JSON.stringify(cfg.args ?? [])) reconnect = true;
    cfg.args = args;
  }
  if (input.cwd !== undefined && input.cwd !== cfg.cwd) {
    cfg.cwd = String(input.cwd).trim() || undefined;
    reconnect = true;
  }
  if (input.url !== undefined && input.url !== cfg.url) {
    cfg.url = String(input.url).trim() || undefined;
    reconnect = true;
  }
  for (const key of ['env', 'headers'] as const) {
    const rec = strRecord(input[key], key);
    if (!rec) continue;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (isKeepValue(v)) {
        if (sec[key][k] !== undefined) next[k] = sec[key][k];
        else if (v === '') next[k] = ''; // new key with an empty value: keep as empty
      } else next[k] = v;
    }
    if (JSON.stringify(next) !== JSON.stringify(sec[key])) reconnect = true;
    sec[key] = next;
  }
  if (input.risk !== undefined) {
    cfg.risk = checkRisk(input.risk, 'risk');
    cfg.riskSet = true;
  }
  if (input.toolRisks !== undefined) {
    if (!input.toolRisks || typeof input.toolRisks !== 'object') bad('toolRisks must be an object');
    cfg.toolRisks = Object.fromEntries(Object.entries(input.toolRisks).map(([k, v]) => [k, checkRisk(v, `toolRisks.${k}`)]));
  }
  if (input.disabledTools !== undefined) {
    if (!Array.isArray(input.disabledTools)) bad('disabledTools must be an array');
    cfg.disabledTools = [...new Set(input.disabledTools.map(String))];
  }
  if (input.alwaysLoad !== undefined) cfg.alwaysLoad = !!input.alwaysLoad;
  validateFinal(cfg);
  return { cfg, sec, reconnect };
}

/** unique id from a wanted id/name (suffix -2, -3, … on collision) */
export function uniqueId(want: string): string {
  const base = slugId(want).slice(0, 36);
  if (!getConfig(base)) return base;
  for (let i = 2; ; i++) if (!getConfig(`${base}-${i}`)) return `${base}-${i}`;
}

export function createConfig(input: McpServerInput, opts: { renameOnCollision?: boolean } = {}): McpServerConfig {
  if (!input || typeof input !== 'object') bad('body must be an object');
  if (!input.name?.trim()) bad('name is required');
  let id = input.id !== undefined ? String(input.id) : slugId(input.name);
  if (input.id !== undefined && !ID_RE.test(id)) bad('id must match [a-z0-9][a-z0-9_-]{0,39}');
  if (getConfig(id)) {
    if (!opts.renameOnCollision) throw new HttpError(409, `an MCP server with id "${id}" already exists`);
    id = uniqueId(id);
  }
  const base: McpServerConfig = {
    id,
    name: input.name.trim(),
    enabled: true,
    transport: input.transport,
    risk: 'sensitive',
    toolRisks: {},
    disabledTools: [],
    alwaysLoad: false,
    createdAt: new Date().toISOString(),
  };
  const { cfg, sec } = apply(base, { env: {}, headers: {} }, { ...input, transport: input.transport ?? base.transport });
  store.update((a) => {
    a.push(cfg);
  });
  setSecrets(id, sec);
  return cfg;
}

export function updateConfig(id: string, patch: Partial<McpServerInput>): { cfg: McpServerConfig; reconnect: boolean } {
  const cur = getConfig(id);
  if (!cur) throw new HttpError(404, `no MCP server "${id}"`);
  if (patch.id !== undefined && patch.id !== id) bad('id cannot be changed');
  const { cfg, sec, reconnect } = apply(cur, getSecrets(id), patch);
  store.update((a) => {
    const i = a.findIndex((s) => s.id === id);
    if (i >= 0) a[i] = cfg;
  });
  setSecrets(id, sec);
  return { cfg, reconnect };
}

export function deleteConfig(id: string): void {
  if (!getConfig(id)) throw new HttpError(404, `no MCP server "${id}"`);
  store.update((a) => a.filter((s) => s.id !== id));
  forgetSecrets(id);
}

/* ─────────────── import (Claude Desktop / Claude Code / Cursor JSON) ─────────────── */

/** parse {"mcpServers": {...}} (or the bare inner object, or {"servers": {...}} VS Code style) into inputs */
export function parseImport(json: unknown): McpServerInput[] {
  let v: unknown = json;
  if (typeof v === 'string') {
    const text = v.trim();
    try {
      v = JSON.parse(text);
    } catch {
      // tolerate a pasted fragment like `"name": {...}` without the outer braces
      try {
        v = JSON.parse(`{${text.replace(/,\s*$/, '')}}`);
      } catch {
        bad('could not parse JSON');
      }
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad('expected a JSON object');
  const obj = v as Record<string, any>;
  const servers: Record<string, any> =
    obj.mcpServers && typeof obj.mcpServers === 'object'
      ? obj.mcpServers
      : obj.servers && typeof obj.servers === 'object'
        ? obj.servers
        : obj;
  const out: McpServerInput[] = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) bad(`server "${name}" must be an object`);
    const type = String(s.type ?? s.transport ?? '').toLowerCase();
    const url = s.url ?? s.serverUrl;
    let transport: McpTransport;
    if (s.command) transport = 'stdio';
    else if (url) transport = type === 'sse' ? 'sse' : 'http';
    else bad(`server "${name}" has neither "command" nor "url"`);
    out.push({
      name,
      transport,
      ...(transport === 'stdio'
        ? {
            command: String(s.command),
            args: Array.isArray(s.args) ? s.args.map(String) : [],
            ...(s.cwd ? { cwd: String(s.cwd) } : {}),
            ...(s.env ? { env: strRecord(s.env, `${name}.env`) } : {}),
          }
        : { url: String(url), ...(s.headers ? { headers: strRecord(s.headers, `${name}.headers`) } : {}) }),
      enabled: s.disabled === true ? false : true,
    });
  }
  return out;
}
