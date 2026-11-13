/**
 * Tool plumbing shared by both engines: which ToolDefs a session gets, risk lookup for
 * Claude Code built-ins, and a uniform "run a ToolDef" wrapper (zod parse, activity log, text result).
 */
import type { SessionKind, ToolRisk } from '@monarch/shared';
import { activity, toolResultText, type ToolContext, type ToolDef } from '../kernel.ts';
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

const BUILTIN_RISK: Record<string, ToolRisk> = {
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
