/** Tiny registry of the JSON stores owned by services, so shutdown can flush them synchronously. */
import { dataStore, notifications, type JsonStore } from '../kernel.ts';

const stores: JsonStore<unknown>[] = [];

/** dataStore() that is also flushed on shutdown */
export function serviceStore<T>(name: string, defaults: T): JsonStore<T> {
  const s = dataStore<T>(name, defaults);
  stores.push(s as JsonStore<unknown>);
  return s;
}

/** synchronously write every tracked store (best effort) */
export function flushAll(): void {
  for (const s of [...stores, notifications as JsonStore<unknown>]) {
    try {
      s.flush();
    } catch (e) {
      console.error(`[core] flush failed for ${s.file}:`, e);
    }
  }
}
