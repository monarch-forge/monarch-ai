/** Live ToolDefs contributed by active extensions (always deferred; core tool names win on collision). */
import { z } from 'zod';
import type { ToolDef } from '../kernel.ts';
import { tools as system } from '../tools/system.ts';
import { tools as productivity } from '../tools/productivity.ts';
import { tools as web } from '../tools/web.ts';
import { tools as coding } from '../tools/coding.ts';
import { tools as mail } from '../tools/mail.ts';
import { tools as slack } from '../tools/slack.ts';
import { tools as memory } from '../tools/memory.ts';
// evolve.ts imports extensions/index (cycle): only read at call time, never during module evaluation
import { tools as evolve } from '../tools/evolve.ts';
import type { HostToolInfo } from './ipc.ts';
import { activeRuntimes, callTool, registryGeneration } from './manager.ts';
import { appendLog } from './store.ts';

function coreNames(): Set<string> {
  const s = new Set<string>();
  for (const list of [system, productivity, web, coding, mail, slack, memory, evolve]) for (const t of list ?? []) s.add(t.name);
  return s;
}

export const toolPrefix = (extId: string): string => extId.replace(/-/g, '_');
export const fullToolName = (extId: string, tool: string): string => `${toolPrefix(extId)}_${tool}`;

/** JSON Schema → ZodObject (the claude engine needs `.shape`) */
export function zodFromJsonSchema(js: Record<string, unknown>): z.ZodObject<any> {
  try {
    const s = z.fromJSONSchema(js as Parameters<typeof z.fromJSONSchema>[0]);
    if (s instanceof z.ZodObject) return s;
  } catch {
    /* fall through */
  }
  const props = js.properties && typeof js.properties === 'object' ? (js.properties as Record<string, { description?: string }>) : {};
  const req = new Set(Array.isArray(js.required) ? (js.required as string[]) : []);
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(props)) {
    let t: z.ZodType = z.any();
    if (v?.description) t = t.describe(String(v.description));
    shape[k] = req.has(k) ? t : t.optional();
  }
  return z.object(shape).passthrough();
}

let cache: { gen: number; defs: ToolDef[] } | null = null;
const warned = new Set<string>();

function buildDef(extId: string, extName: string, t: HostToolInfo): ToolDef {
  const name = fullToolName(extId, t.name);
  return {
    name,
    description: `[${extName}] ${t.description}`,
    risk: t.risk,
    schema: zodFromJsonSchema(t.schema),
    tag: 'EXT',
    loading: 'deferred',
    group: `ext:${extId}`,
    keywords: [extId, extName.toLowerCase(), t.name],
    extensionId: extId,
    summarize: (input) => {
      let args = '';
      try {
        args = JSON.stringify(input);
      } catch {
        /* ignore */
      }
      return `${extName}: ${t.name}${args && args !== '{}' ? ` ${args.length > 100 ? `${args.slice(0, 100)}…` : args}` : ''}`;
    },
    run: (input, ctx) => callTool(extId, t.name, input, { onProgress: (p) => ctx.progress(p), signal: ctx.signal }),
  };
}

/** sync + live: one ToolDef per tool of every active extension */
export function extensionToolDefs(): ToolDef[] {
  const gen = registryGeneration();
  if (cache && cache.gen === gen) return cache.defs;
  const reserved = coreNames();
  const seen = new Set<string>();
  const defs: ToolDef[] = [];
  for (const rt of activeRuntimes()) {
    for (const t of rt.registry?.tools ?? []) {
      const name = fullToolName(rt.id, t.name);
      if (reserved.has(name) || seen.has(name)) {
        const key = `${rt.id}:${name}`;
        if (!warned.has(key)) {
          warned.add(key);
          appendLog(rt.id, 'warn', `tool "${name}" collides with an existing tool — skipped`);
        }
        continue;
      }
      seen.add(name);
      defs.push(buildDef(rt.id, rt.manifest.name, t));
    }
  }
  cache = { gen, defs };
  return defs;
}
