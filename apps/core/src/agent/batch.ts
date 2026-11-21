/**
 * batch: many tool calls in one round trip, a middle ground between plain tool calling and "code mode".
 * - calls: different tools at once
 * - each:  one tool over a list of items (ids, names, …) with "$item" / "$item.field" in its args
 * - grep / max_chars: trim every result so bulk reads don't flood the context
 * Every inner call is validated and approved exactly like a direct call. Dangerous tools (send, post,
 * delete, …) are refused here: they must be called directly so each one is seen on its own.
 */
import { z } from 'zod';
import { defineTool, type ToolContext, type ToolDef } from '../kernel.ts';
import { canRunParallel } from './parallel.ts';

export const BATCH = 'batch';
const NO_NEST = new Set([BATCH, 'tool_search']);
const MAX_CALLS = 50;
const POOL = 4;
const TOTAL_CHARS = 12_000;

export type InnerCall = (name: string, input: unknown) => Promise<string>;

/** engines build this: look up a session tool, approve it like a direct call, run it */
export function innerCaller(
  lookup: (name: string) => ToolDef | undefined,
  approve: (ask: { callId: string; name: string; input: unknown; risk: ToolDef['risk']; summary: string }) => Promise<boolean>,
  run: (def: ToolDef, input: unknown) => Promise<string>,
  parentId: string,
): InnerCall {
  let n = 0;
  return async (name, input) => {
    const def = lookup(name);
    if (!def) throw new Error(`Unknown tool "${name}". Use tool_search to find the right name.`);
    if (NO_NEST.has(def.name)) throw new Error(`${def.name} cannot run inside batch.`);
    if (def.risk === 'dangerous') throw new Error(`${def.name} sends, posts or deletes: call it directly, not inside batch.`);
    const ok = await approve({ callId: `${parentId}:${++n}`, name: def.name, input, risk: def.risk, summary: `batch → ${def.name}` });
    if (!ok) throw new Error('The user declined this action. Do not retry it.');
    return run(def, input);
  };
}

/** replace "$item" / "$item.a.b" string values (whole value only) with the current item */
export function fill(args: unknown, item: unknown): unknown {
  if (typeof args === 'string') {
    if (args === '$item') return item;
    if (args.startsWith('$item.')) {
      let v: any = item;
      for (const k of args.slice(6).split('.')) v = v == null ? undefined : v[k];
      return v;
    }
    return args;
  }
  if (Array.isArray(args)) return args.map((a) => fill(a, item));
  if (args && typeof args === 'object') return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, fill(v, item)]));
  return args;
}

/** keep lines containing any grep term (case-insensitive), then cap the length */
export function trim(text: string, grep: string[] | undefined, max: number): string {
  let t = text;
  if (grep?.length) {
    const terms = grep.map((g) => g.toLowerCase()).filter(Boolean);
    const lines = t.split('\n').filter((l) => terms.some((g) => l.toLowerCase().includes(g)));
    t = lines.length ? lines.join('\n') : '(no lines matched grep)';
  }
  return t.length > max ? `${t.slice(0, max)}… [+${t.length - max} chars]` : t;
}

async function pool<T, R>(items: T[], size: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const schema = z.object({
  calls: z
    .array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional() }))
    .max(20)
    .optional()
    .describe('Different tool calls to run together.'),
  each: z
    .object({
      tool: z.string(),
      items: z.array(z.unknown()).min(1).max(MAX_CALLS).describe('Values to loop over, e.g. ids from an earlier result.'),
      args: z.record(z.string(), z.unknown()).describe('Args for every call; "$item" or "$item.field" is replaced per item.'),
    })
    .optional()
    .describe('One tool run once per item.'),
  grep: z.array(z.string()).optional().describe('Keep only result lines containing any of these words.'),
  max_chars: z.number().int().min(200).max(8000).optional().describe('Max characters kept per result (default 1500).'),
});

export function batchTool(lookupDef: (name: string) => ToolDef | undefined): ToolDef<typeof schema> {
  return defineTool({
    name: BATCH,
    description:
      'Run many tool calls in one step and get trimmed results back. Use for repetitive work: read 10 threads, ' +
      'update 20 ledger entries, look up several people. Example: {"each":{"tool":"mail_read_thread","items":["id1","id2"],"args":{"threadId":"$item"}},"max_chars":800}. ' +
      'Send, post and delete tools are not allowed here; call those directly.',
    risk: 'safe',
    schema,
    group: 'meta',
    loading: 'always',
    keywords: ['many', 'bulk', 'loop', 'each', 'multiple calls'],
    summarize: (i) => `${(i.calls?.length ?? 0) + (i.each?.items.length ?? 0)} calls${i.each ? ` · ${i.each.tool} ×${i.each.items.length}` : ''}`,
    async run(input, ctx: ToolContext) {
      const call = ctx.callTool;
      if (!call) throw new Error('batch is not available in this session.');
      const jobs: { tool: string; args: unknown; label: string }[] = [
        ...(input.calls ?? []).map((c) => ({ tool: c.tool, args: c.args ?? {}, label: c.tool })),
        ...(input.each ? input.each.items.map((it) => ({ tool: input.each!.tool, args: fill(input.each!.args, it), label: `${input.each!.tool} ${JSON.stringify(it).slice(0, 60)}` })) : []),
      ];
      if (!jobs.length) throw new Error('Give "calls" or "each".');
      if (jobs.length > MAX_CALLS) throw new Error(`At most ${MAX_CALLS} calls per batch.`);
      const max = input.max_chars ?? 1500;
      // read-only tools overlap a few at a time; anything that writes runs in order
      const parallel = jobs.every((j) => {
        const d = lookupDef(j.tool);
        return !!d && canRunParallel(d);
      });
      let done = 0;
      const results = await pool(jobs, parallel ? POOL : 1, async (j, i) => {
        if (ctx.signal.aborted) return `#${i + 1} ${j.label}: aborted`;
        try {
          const text = await call(j.tool, j.args);
          return `#${i + 1} ${j.label}\n${trim(text, input.grep, max)}`;
        } catch (e: any) {
          return `#${i + 1} ${j.label}: ERROR ${String(e?.message ?? e).split('\n')[0]}`;
        } finally {
          ctx.progress(`${++done}/${jobs.length}`);
        }
      });
      const failed = results.filter((r) => r.includes(': ERROR ')).length;
      const head = `${jobs.length} calls, ${jobs.length - failed} ok${failed ? `, ${failed} failed` : ''}.`;
      const body = results.join('\n\n');
      return `${head}\n\n${body.length > TOTAL_CHARS ? `${body.slice(0, TOTAL_CHARS)}… [output capped; lower max_chars or use grep]` : body}`;
    },
  });
}
