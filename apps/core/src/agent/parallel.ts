import type { ToolDef } from '../kernel.ts';

/**
 * Read-only safe tools may run at the same time as each other (pi runs a batch in parallel only when every
 * call in it allows it). Anything needing approval, and safe tools that write state where order matters
 * (plan_set then plan_step, memory_write, thread_upsert, …), keep the batch sequential.
 */
// batch may hold writes, so it never overlaps other calls
const ORDERED_WRITE = /(_save|_write|_link|_set|_step|_upsert|_close|_propose)$|^send_|^batch$/;
export function canRunParallel(def: Pick<ToolDef, 'name' | 'risk'>): boolean {
  return def.risk === 'safe' && !ORDERED_WRITE.test(def.name);
}
