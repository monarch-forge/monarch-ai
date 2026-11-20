/**
 * Tool plumbing shared by both engines: which ToolDefs a session gets, risk lookup for
 * Claude Code built-ins, and a uniform "run a ToolDef" wrapper (zod parse, activity log, text result).
 */
import { z } from 'zod';
import type { EngineId, SessionKind, ToolRisk } from '@monarch/shared';
import { activity, isAlwaysLoaded, secrets, toolResultText, type ToolContext, type ToolDef } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { assistantTools, codingTools } from '../tools/index.ts';

/**
 * Extra tools registered at runtime (tests, future plugins). Appended to every session's
 * assistant tool set. Names must not collide with registry tools (registry wins).
 */
export const extraTools: ToolDef[] = [];

/** tools for the claude-sdk engine (it brings its own file/shell tools) */
export function sdkToolDefs(kind?: SessionKind): ToolDef[] {
  return dedupe(forKind([...assistantTools(), ...extraTools], kind));
}

/** the threads board exists only in Chat sessions */
const forKind = (list: ToolDef[], kind?: SessionKind) => (!kind || kind === 'chat' ? list : list.filter((t) => t.group !== 'threads'));

/** tools for the pi engine: assistant tools + (coding sessions) Monarch's own coding tools */
export function piToolDefs(kind: SessionKind): ToolDef[] {
  const base = forKind([...assistantTools(), ...extraTools], kind);
  return dedupe(kind === 'coding' ? [...base, ...codingTools()] : base);
}

function dedupe(list: ToolDef[]): ToolDef[] {
  const seen = new Set<string>();
  const out: ToolDef[] = [];
  for (const t of list) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push(t);
  }
  return out;
}

/* ────────────────────────────── deferred loading / tool search ────────────────────────────── */

/** settings.evolution.deferTools (default on): only core tools up front, the rest via tool search */
export function deferToolsEnabled(): boolean {
  return getSettings().evolution?.deferTools !== false;
}

/* ────────────────────────────── small-model mode ────────────────────────────── */

const SMALL_RE = /flash|lite|mini|haiku|nano|small|fast|\b(9|8|7|3)b\b|[-_:](9|8|7|3)b/i;
const SMALL_WINDOW = 64_000;

/** settings.agent.smallModelMode (default 'auto') */
export function smallModelSetting(): 'auto' | 'on' | 'off' {
  const m = getSettings().agent?.smallModelMode;
  return m === 'on' || m === 'off' ? m : 'auto';
}

/** heuristic: does this model look small (cheap/fast tier or a short context window)? */
export function looksSmall(id: string, name = '', contextWindow?: number): boolean {
  if (SMALL_RE.test(id) || (name && SMALL_RE.test(name))) return true;
  return !!contextWindow && contextWindow > 0 && contextWindow < SMALL_WINDOW;
}

/** small-model mode for a concrete model (applies the on/off/auto setting) */
export function smallModeFor(id: string, name = '', contextWindow?: number): boolean {
  const mode = smallModelSetting();
  if (mode !== 'auto') return mode === 'on';
  return looksSmall(id, name, contextWindow);
}

/** small-model mode for a session's engine/model (resolves pi models for their name/context window) */
export async function smallModeForSession(engine: EngineId, modelSpec?: string, piProvider?: string): Promise<boolean> {
  const mode = smallModelSetting();
  if (mode !== 'auto') return mode === 'on';
  const s = getSettings();
  if (engine === 'claude-sdk') return looksSmall(modelSpec || s.claudeSdk.model);
  const spec = modelSpec || s.pi.model;
  try {
    const { resolvePiModel } = await import('./pi-models.ts');
    const { model } = resolvePiModel(piProvider || s.pi.provider, spec);
    if (model) return looksSmall(model.id, model.name, model.contextWindow);
  } catch {
    /* fall through */
  }
  return looksSmall(spec);
}

/** tools loaded up front in small-model mode (small models struggle with tool search) */
export const SMALL_MODE_UPFRONT = new Set([
  'tasks_list', 'task_add', 'task_update', 'task_complete',
  'calendar_list', 'calendar_add',
  'automations_list', 'automation_create',
  'mail_search', 'mail_read_thread', 'mail_draft', 'mail_modify', 'mail_cleanup',
  'slack_unread', 'slack_read', 'slack_search', 'slack_post', 'slack_mark_read', 'slack_react',
  'memory_search', 'memory_read', 'memory_write',
  'agent_start', 'agent_send', 'agent_status', 'agent_wait', 'agent_list',
]);

/** small mode loads mail/Slack tools up front only when such an account is connected (window space is precious) */
function smallUpfront(name: string): boolean {
  if (!SMALL_MODE_UPFRONT.has(name)) return false;
  const sec = secrets.get();
  if (name.startsWith('mail_')) return Object.keys(sec.google?.accounts ?? {}).length > 0;
  if (name.startsWith('slack_')) return Object.keys(sec.slack ?? {}).length > 0;
  return true;
}

/** whether a tool's schema goes into every prompt (everything is, when deferral is off) */
export function loadsUpFront(def: ToolDef, defer = deferToolsEnabled(), small = false): boolean {
  return !defer || isAlwaysLoaded(def) || (small && smallUpfront(def.name));
}

export function splitByLoading(defs: ToolDef[], defer = deferToolsEnabled(), small = false): { always: ToolDef[]; deferred: ToolDef[] } {
  const always: ToolDef[] = [];
  const deferred: ToolDef[] = [];
  for (const d of defs) (loadsUpFront(d, defer, small) ? always : deferred).push(d);
  return { always, deferred };
}

/** group name for catalogs/search ('ext:<id>' for extension tools without one) */
export function groupOf(def: ToolDef): string {
  return def.group || (def.extensionId ? `ext:${def.extensionId}` : 'other');
}

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);

/**
 * Rank tools for a tool-search query. Supports `select:name1,name2` (exact names, in order) and
 * free text; terms are matched against name parts, group, keywords and description.
 */
export function searchToolDefs(defs: ToolDef[], query: string, limit = 5): ToolDef[] {
  const q = query.trim();
  const byName = new Map(defs.map((d) => [d.name, d]));
  if (/^select:/i.test(q)) {
    const names = q
      .slice(7)
      .split(',')
      .map((n) => n.trim().replace(/^mcp__[^_]+__/, ''))
      .filter(Boolean);
    return names.map((n) => byName.get(n)).filter((d): d is ToolDef => !!d);
  }
  const exact = byName.get(q);
  if (exact) return [exact];
  const terms = tokens(q);
  if (!terms.length) return [];
  const phrase = q.toLowerCase();
  const scored: { def: ToolDef; score: number }[] = [];
  for (const def of defs) {
    const nameParts = tokens(def.name);
    const group = groupOf(def).toLowerCase();
    const kws = (def.keywords ?? []).map((k) => k.toLowerCase());
    const kwTokens = new Set(kws.flatMap(tokens));
    const descTokens = new Set(tokens(def.description));
    let score = 0;
    let hits = 0;
    for (const t of terms) {
      let s = 0;
      if (nameParts.includes(t)) s = Math.max(s, 6);
      else if (def.name.toLowerCase().includes(t)) s = Math.max(s, 4);
      if (group === t || tokens(group).includes(t)) s = Math.max(s, 4);
      if (kwTokens.has(t)) s = Math.max(s, 3);
      else if (kws.some((k) => k.includes(t))) s = Math.max(s, 2);
      if (descTokens.has(t)) s = Math.max(s, 1.5);
      else if (t.length > 3 && [...descTokens].some((d) => d.startsWith(t))) s = Math.max(s, 1);
      if (s > 0) hits++;
      score += s;
    }
    if (!score) continue;
    if (kws.some((k) => k.length > 3 && phrase.includes(k))) score += 2;
    score *= 0.5 + hits / terms.length / 2; // favour tools matching more of the query
    scored.push({ def, score });
  }
  scored.sort((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name));
  // drop weak tail matches (they would only bloat the loaded set)
  const top = scored[0]?.score ?? 0;
  return scored
    .filter((s) => s.score >= top * 0.4)
    .slice(0, Math.max(1, Math.min(limit, 20)))
    .map((s) => s.def);
}

/** compact "what else exists" index for the system prompt: one line per group of deferred tools */
export function deferredToolIndex(defs: ToolDef[], maxChars = 600, small = false): string {
  const { deferred } = splitByLoading(defs, deferToolsEnabled(), small);
  if (!deferred.length) return '';
  const groups = new Map<string, string[]>();
  for (const d of deferred) {
    const g = groupOf(d);
    groups.set(g, [...(groups.get(g) ?? []), d.name]);
  }
  const lines: string[] = [];
  let used = 0;
  let rest = 0;
  for (const [g, names] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const line = `- ${g} (${names.length}): ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}`;
    if (used + line.length > maxChars) {
      rest += names.length;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (rest) lines.push(`- …and ${rest} more (search to see them)`);
  return lines.join('\n');
}

/** Claude Code built-in tools offered per session kind (claude-sdk engine). */
export const SDK_CHAT_BUILTINS = ['WebSearch', 'WebFetch'];
export const SDK_CODING_BUILTINS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'Grep',
  'Glob',
  'TodoWrite',
  'WebSearch',
  'WebFetch',
];

/** Claude Code's native tool search (added to the built-ins when deferred loading is on) */
export const SDK_TOOL_SEARCH = 'ToolSearch';

const BUILTIN_RISK: Record<string, ToolRisk> = {
  ToolSearch: 'safe',
  Read: 'safe',
  Grep: 'safe',
  Glob: 'safe',
  LS: 'safe',
  WebSearch: 'safe',
  WebFetch: 'safe',
  TodoWrite: 'safe',
  BashOutput: 'safe',
  Write: 'sensitive',
  Edit: 'sensitive',
  MultiEdit: 'sensitive',
  NotebookEdit: 'sensitive',
  KillShell: 'sensitive',
  Bash: 'dangerous',
};

export function builtinRisk(name: string): ToolRisk {
  return BUILTIN_RISK[name] ?? 'sensitive';
}

/** one-line human summary of a Claude Code built-in call (approval prompts) */
export function builtinSummary(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Bash':
      return `Run shell: ${clip(s(input.command), 160)}`;
    case 'Write':
      return `Write file ${s(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit file ${s(input.file_path)}`;
    case 'NotebookEdit':
      return `Edit notebook ${s(input.notebook_path)}`;
    case 'Read':
      return `Read ${s(input.file_path)}`;
    case 'WebFetch':
      return `Fetch ${s(input.url)}`;
    case 'WebSearch':
      return `Search the web: ${s(input.query)}`;
    case 'Grep':
      return `Search files for ${s(input.pattern)}`;
    case 'Glob':
      return `List files ${s(input.pattern)}`;
    case 'KillShell':
      return `Stop background shell ${s(input.shell_id)}`;
    case 'ToolSearch':
      return `Find tools: ${s(input.query)}`;
    default:
      return `${name} ${clip(safeJson(input), 160)}`;
  }
}

export function toolSummary(def: ToolDef, input: unknown): string {
  try {
    if (def.summarize) return def.summarize(input as any);
  } catch {
    /* fall through */
  }
  return `${def.name} ${clip(safeJson(input), 140)}`;
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

/* ────────────────────────────── schemas, search reports, argument repair ────────────────────────────── */

const schemaCache = new WeakMap<ToolDef, Record<string, unknown>>();

/** JSON schema for a ToolDef's zod schema, as plain JSON (cached per def) */
export function toolJsonSchema(def: ToolDef): Record<string, unknown> {
  const hit = schemaCache.get(def);
  if (hit) return hit;
  let js: Record<string, unknown>;
  try {
    js = z.toJSONSchema(def.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    js = { type: 'object', properties: {} };
  }
  delete js.$schema;
  if (js.type !== 'object') js = { type: 'object', properties: {}, ...js };
  schemaCache.set(def, js);
  return js;
}

interface ParamInfo {
  name: string;
  type: string;
  required: boolean;
  nullable: boolean;
  description: string;
}

function typeOf(p: any): { type: string; nullable: boolean } {
  if (!p || typeof p !== 'object') return { type: 'any', nullable: true };
  if (Array.isArray(p.anyOf) || Array.isArray(p.oneOf)) {
    const alts = (p.anyOf ?? p.oneOf) as any[];
    const parts = alts.map((a) => typeOf(a));
    const nullable = parts.some((x) => x.nullable || x.type === 'null');
    const types = [...new Set(parts.map((x) => x.type).filter((t) => t !== 'null'))];
    return { type: types.join(' | ') || 'any', nullable };
  }
  if (Array.isArray(p.enum)) return { type: p.enum.map((e: unknown) => JSON.stringify(e)).join(' | '), nullable: p.enum.includes(null) };
  if (Array.isArray(p.type)) return { type: p.type.filter((t: string) => t !== 'null').join(' | '), nullable: p.type.includes('null') };
  if (p.type === 'array') return { type: `${typeOf(p.items).type}[]`, nullable: false };
  if (p.type === 'null') return { type: 'null', nullable: true };
  return { type: p.type ?? 'any', nullable: !p.type };
}

export function toolParams(def: ToolDef): ParamInfo[] {
  const js = toolJsonSchema(def) as { properties?: Record<string, any>; required?: string[] };
  const req = new Set(js.required ?? []);
  return Object.entries(js.properties ?? {}).map(([name, p]) => {
    const t = typeOf(p);
    return { name, type: t.type, nullable: t.nullable, required: req.has(name), description: String(p?.description ?? '').replace(/\s+/g, ' ').trim() };
  });
}

/** "- title (string, required): Short task title." lines */
export function paramLines(def: ToolDef): string[] {
  const ps = toolParams(def);
  if (!ps.length) return ['(no parameters)'];
  return ps.map((p) => `- ${p.name} (${p.type}, ${p.required ? 'required' : 'optional'})${p.description ? `: ${clip(p.description, 140)}` : ''}`);
}

/** common names models use for a parameter → the parameter it most likely means */
const SYNONYMS: Record<string, string[]> = {
  title: ['task', 'name', 'summary', 'subject', 'label', 'text', 'content', 'todo', 'item'],
  text: ['content', 'body', 'message', 'note', 'msg'],
  notes: ['content', 'body', 'note', 'details', 'description'],
  body: ['content', 'text', 'message'],
  message: ['text', 'content', 'body', 'msg', 'instruction', 'instructions'],
  description: ['details', 'notes', 'body'],
  due: ['when', 'date', 'time', 'deadline', 'due_date', 'dueDate', 'due_at', 'dueAt'],
  remindAt: ['remind_at', 'reminder', 'remind', 'reminder_time', 'when'],
  start: ['when', 'date', 'time', 'start_time', 'startTime', 'datetime', 'start_at', 'startAt'],
  end: ['end_time', 'endTime', 'end_at', 'endAt', 'until'],
  query: ['q', 'search', 'keywords', 'term', 'keyword'],
  prompt: ['instruction', 'instructions', 'task', 'command'],
  task: ['prompt', 'instructions', 'instruction', 'description', 'message', 'request'],
  schedule: ['cron', 'every', 'when', 'frequency', 'interval'],
  sessionId: ['session_id', 'session', 'id', 'agentId', 'agent_id', 'agent'],
  cwd: ['workspace', 'dir', 'directory', 'path', 'folder', 'repo'],
  name: ['title', 'label'],
  id: ['taskId', 'task_id', 'eventId', 'event_id'],
};

const lc = (s: string) => s.toLowerCase().replace(/[_-]/g, '');

/**
 * Best-effort repair of model-produced arguments before validation. Only unambiguous fixes:
 * stringified JSON args, null for optional params, "42"/"true" for number/boolean params, and
 * unknown keys that clearly mean a missing parameter (task → title when title is missing and
 * task is not a real parameter). Returns the args and a description of every change.
 */
export function repairArgs(def: ToolDef, raw: unknown): { args: unknown; repairs: string[] } {
  const repairs: string[] = [];
  let input = raw;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed;
        repairs.push('parsed stringified JSON arguments');
      }
    } catch {
      /* not JSON */
    }
  }
  const params = toolParams(def);
  if (typeof input === 'string') {
    const reqStr = params.filter((p) => p.required && p.type === 'string');
    if (reqStr.length === 1) {
      repairs.push(`wrapped bare string as ${reqStr[0].name}`);
      return { args: { [reqStr[0].name]: input }, repairs };
    }
    return { args: input, repairs };
  }
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) return { args: input, repairs };
  const obj: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const byName = new Map(params.map((p) => [p.name, p]));
  const byLc = new Map(params.map((p) => [lc(p.name), p.name]));

  // case/underscore variants of real names (due_date → dueDate is handled by synonyms; Title → title here)
  for (const k of Object.keys(obj)) {
    if (byName.has(k)) continue;
    const real = byLc.get(lc(k));
    if (real && !(real in obj)) {
      obj[real] = obj[k];
      delete obj[k];
      repairs.push(`${k} → ${real}`);
    }
  }
  // value coercions
  for (const [k, v] of Object.entries(obj)) {
    const p = byName.get(k);
    if (!p) continue;
    if (v === null && !p.nullable && !p.required) {
      delete obj[k];
      repairs.push(`dropped null ${k}`);
    } else if (typeof v === 'string' && /^(number|integer)$/.test(p.type) && v.trim() && !Number.isNaN(Number(v))) {
      obj[k] = Number(v);
      repairs.push(`${k} "${v}" → number`);
    } else if (typeof v === 'string' && p.type === 'boolean' && /^(true|false)$/i.test(v.trim())) {
      obj[k] = v.trim().toLowerCase() === 'true';
      repairs.push(`${k} "${v}" → boolean`);
    } else if (typeof v === 'string' && p.type.endsWith('[]') && !v.trim().startsWith('[')) {
      obj[k] = v.split(',').map((x) => x.trim()).filter(Boolean);
      repairs.push(`${k} string → list`);
    }
  }
  // synonyms: unknown key → a missing parameter that it unambiguously names
  const unknown = () => Object.keys(obj).filter((k) => !byName.has(k));
  const targets = params.filter((p) => !(p.name in obj)).sort((a, b) => Number(b.required) - Number(a.required));
  for (const p of targets) {
    const syn = (SYNONYMS[p.name] ?? []).map(lc);
    const cands = unknown().filter((k) => syn.includes(lc(k)));
    if (cands.length !== 1) continue;
    // ambiguous when the same unknown key could also fill another missing param of equal rank
    const k = cands[0];
    const rivals = targets.filter((o) => o !== p && !(o.name in obj) && o.required === p.required && (SYNONYMS[o.name] ?? []).map(lc).includes(lc(k)));
    if (rivals.length) continue;
    obj[p.name] = obj[k];
    delete obj[k];
    repairs.push(`${k} → ${p.name}`);
  }
  // last resort: exactly one missing required string param and exactly one unknown string value
  const missingReq = params.filter((p) => p.required && !(p.name in obj));
  const unk = unknown();
  if (missingReq.length === 1 && missingReq[0].type === 'string' && unk.length === 1 && typeof obj[unk[0]] === 'string') {
    const k = unk[0];
    obj[missingReq[0].name] = obj[k];
    delete obj[k];
    repairs.push(`${k} → ${missingReq[0].name}`);
  }
  return { args: obj, repairs };
}

/** a validation error that tells the model exactly how to call the tool */
export function teachingError(def: ToolDef, input: unknown, error: z.ZodError): string {
  const params = toolParams(def);
  const known = new Set(params.map((p) => p.name));
  const problems: string[] = [];
  const missing: string[] = [];
  for (const iss of error.issues) {
    const key = String(iss.path[0] ?? '');
    const p = params.find((x) => x.name === key);
    const absent = !!key && (input == null || typeof input !== 'object' || !(key in (input as object)));
    if (p && absent && p.required) {
      missing.push(key);
      problems.push(`missing required "${key}" (${p.type})${p.description ? ` — ${clip(p.description, 100)}` : ''}`);
    } else {
      problems.push(`${iss.path.length ? `"${iss.path.join('.')}"` : 'arguments'}: ${iss.message}`);
    }
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const k of Object.keys(input)) if (!known.has(k)) problems.push(`unknown parameter "${k}" (not accepted by ${def.name})`);
  }
  const example: Record<string, string> = {};
  for (const p of params.filter((x) => x.required)) example[p.name] = '…';
  const hint = missing.length
    ? `Call ${def.name} again with {${missing.map((m) => `"${m}": …`).join(', ')}${params.some((p) => p.required && !missing.includes(p.name)) ? ', …' : ''}}.`
    : `Call ${def.name} again with arguments like ${JSON.stringify(example)}.`;
  return [`Invalid arguments for ${def.name}:`, ...problems.map((x) => `- ${x}`), `Expected parameters of ${def.name}:`, ...paramLines(def), hint].join('\n');
}

/** apply repairArgs (logging any change) and validate; returns parsed data or a teaching error */
export function prepareArgs(def: ToolDef, rawInput: unknown): { ok: true; data: unknown; repairs: string[] } | { ok: false; error: string } {
  const { args, repairs } = repairArgs(def, rawInput);
  if (repairs.length) console.info(`[tools] repaired ${def.name} args: ${repairs.join('; ')}`);
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: teachingError(def, args, parsed.error) };
  return { ok: true, data: parsed.data, repairs };
}

/** parse input with the tool's zod schema (after repairs), run it, stringify the result. Throws on failure. */
export async function runToolDef(def: ToolDef, rawInput: unknown, ctx: ToolContext): Promise<string> {
  const prep = prepareArgs(def, rawInput);
  if (!prep.ok) throw new Error(prep.error);
  if (def.tag) activity(def.tag, clip(toolSummary(def, prep.data), 120), 'info', ctx.sessionId);
  const result = await def.run(prep.data as Record<string, unknown>, ctx);
  let text = toolResultText(result);
  // small models drown in long results: keep the head and say how to get the rest
  if (ctx.small && text.length > SMALL_RESULT_CHARS) {
    text = `${text.slice(0, SMALL_RESULT_CHARS)}\n… [clipped ${text.length - SMALL_RESULT_CHARS} chars — narrow the query (filters, limit, a specific id) if you need more]`;
  }
  // polling tools (worker status) legitimately repeat while work runs
  return def.group === 'worker-agents' ? text : text + repeatNote(ctx.sessionId, def.name, prep.data, text);
}

const SMALL_RESULT_CHARS = 6000;
const recentCalls = new Map<string, { key: string; result: string; n: number; at: number }>();

/** lite models loop on the same call; the 3rd identical call with an identical result gets a nudge to move on */
function repeatNote(sessionId: string | undefined, name: string, args: unknown, result: string): string {
  if (!sessionId) return '';
  let key: string;
  try {
    key = `${name}:${JSON.stringify(args)}`;
  } catch {
    return '';
  }
  const prev = recentCalls.get(sessionId);
  const now = Date.now();
  const same = prev && prev.key === key && prev.result === result && now - prev.at < 10 * 60_000;
  const n = same ? prev.n + 1 : 1;
  recentCalls.set(sessionId, { key, result, n, at: now });
  if (recentCalls.size > 500) recentCalls.delete(recentCalls.keys().next().value!);
  return n >= 3 ? `\n\n[Monarch note: this is the same call with the same result ${n} times in a row. Stop repeating it — use this result, try a different approach, or report what you found.]` : '';
}

/* tool search report (shared by pi's tool_search) */

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

/** closest tool names to a free-form string (typos, partial names, word overlap) */
export function closestToolNames(defs: ToolDef[], query: string, n = 6): string[] {
  const q = query.toLowerCase().replace(/^select:/, '').trim();
  const qt = new Set(tokens(q));
  return defs
    .map((d) => {
      const name = d.name.toLowerCase();
      const overlap = tokens(name).filter((t) => qt.has(t) || [...qt].some((x) => x.length > 2 && (t.startsWith(x) || x.startsWith(t)))).length;
      const dist = editDistance(q.slice(0, 40), name) / Math.max(q.length, name.length, 1);
      return { name: d.name, score: overlap * 2 - dist };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.name);
}

/**
 * Tool search over EVERY tool the session has. Loaded tools come back marked "already loaded";
 * deferred matches are returned in `activate`. Never dead-ends: no match lists the closest names + groups.
 */
export function toolSearchReport(
  all: ToolDef[],
  isLoaded: (d: ToolDef) => boolean,
  query: string,
  limit = 5,
): { text: string; activate: string[] } {
  const q = query.trim();
  let hits: ToolDef[];
  const unknownNames: string[] = [];
  if (/^select:/i.test(q)) {
    hits = searchToolDefs(all, q);
    const found = new Set(hits.map((h) => h.name));
    for (const n of q.slice(7).split(',').map((x) => x.trim().replace(/^mcp__[^_]+__/, '')).filter(Boolean)) if (!found.has(n)) unknownNames.push(n);
  } else {
    hits = searchToolDefs(all, q, limit);
  }
  const groups = [...new Set(all.map(groupOf))].sort().join(', ');
  if (!hits.length) {
    const close = closestToolNames(all, unknownNames.join(' ') || q);
    return {
      text: `No tool is named or described by "${q}". Closest tool names: ${close.join(', ')}. Tool groups: ${groups}. Call one of the closest tools directly if it fits, or search with other keywords (e.g. "select:${close[0] ?? 'name'}").`,
      activate: [],
    };
  }
  const activate = hits.filter((d) => !isLoaded(d)).map((d) => d.name);
  const lines = hits.map((d) => {
    const desc = d.description.replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0] ?? '';
    const tag = isLoaded(d) ? 'already loaded — call it directly' : 'loaded now';
    return `- ${d.name} [${tag}]: ${desc}\n  parameters:\n${paramLines(d).map((l) => `    ${l}`).join('\n')}`;
  });
  const missing = unknownNames.length ? `\nNot found: ${unknownNames.join(', ')} (closest: ${closestToolNames(all, unknownNames.join(' ')).slice(0, 4).join(', ')}).` : '';
  return { text: `Call these tools directly now (do not search for them again):\n${lines.join('\n')}${missing}`, activate };
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/* ─────────────── compact tool specs for small models ─────────────── */

/** first sentences of a description, up to `max` chars (never cuts mid-word) */
export function shortDesc(text: string | undefined, max: number): string | undefined {
  if (!text) return text;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  // keep abbreviations (e.g., i.e., etc.) from ending a sentence
  const sentences = (t.replace(/\b(e\.g|i\.e|etc|vs)\./gi, '$1\u0000').match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? []).map((x) => x.replace(/\u0000/g, '.'));
  let out = '';
  for (const sn of sentences) {
    if ((out + sn).length > max) break;
    out += sn;
  }
  if (out.trim().length >= max * 0.4) return out.trim();
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6))}…`;
}
