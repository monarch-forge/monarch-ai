/** Small HTTP helpers for route handlers. */
import type { Context } from 'hono';
import { HttpError } from '../kernel.ts';

/** parse the JSON body or throw HttpError(400) */
export async function readJson<T = Record<string, any>>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}
