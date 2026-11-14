/**
 * Tool plumbing shared by both engines: which ToolDefs a session gets, risk lookup for
 * Claude Code built-ins, and a uniform "run a ToolDef" wrapper (zod parse, activity log, text result).
 */
import type { SessionKind, ToolRisk } from '@monarch/shared';
import { activity, isAlwaysLoaded, toolResultText, type ToolContext, type ToolDef } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { assistantTools, codingTools } from '../tools/index.ts';

/**
 * Extra tools registered at runtime (tests, future plugins). Appended to every session's
 * assistant tool set. Names must not collide with registry tools (registry wins).
 */
export const extraTools: ToolDef[] = [];

/** tools for the claude-sdk engine (it brings its own file/shell tools) */
export function sdkToolDefs(): ToolDef[] {
  return dedupe([...assistantTools(), ...extraTools]);
}

/** tools for the pi engine: assistant tools + (coding sessions) Monarch's own coding tools */
export function piToolDefs(kind: SessionKind): ToolDef[] {
  const base = [...assistantTools(), ...extraTools];
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

/** whether a tool's schema goes into every prompt (everything is, when deferral is off) */
export function loadsUpFront(def: ToolDef, defer = deferToolsEnabled()): boolean {
  return !defer || isAlwaysLoaded(def);
}

export function splitByLoading(defs: ToolDef[], defer = deferToolsEnabled()): { always: ToolDef[]; deferred: ToolDef[] } {
  const always: ToolDef[] = [];
  const deferred: ToolDef[] = [];
  for (const d of defs) (loadsUpFront(d, defer) ? always : deferred).push(d);
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
export function deferredToolIndex(defs: ToolDef[], maxChars = 600): string {
  const { deferred } = splitByLoading(defs);
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

/** parse input with the tool's zod schema, run it, stringify the result. Throws on failure. */
export async function runToolDef(def: ToolDef, rawInput: unknown, ctx: ToolContext): Promise<string> {
  const parsed = def.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid arguments for ${def.name}: ${parsed.error.message}`);
  }
  if (def.tag) activity(def.tag, clip(toolSummary(def, parsed.data), 120), 'info', ctx.sessionId);
  const result = await def.run(parsed.data, ctx);
  return toolResultText(result);
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
