/** GitHub PR inbox (via the user's `gh` CLI). */
import type { Hono } from 'hono';
import { listPrs } from '../integrations/github.ts';

export function register(app: Hono): void {
  app.get('/api/github/prs', async (c) => {
    try {
      return c.json({ prs: await listPrs() });
    } catch (e) {
      return c.json({ prs: [], error: (e as Error).message });
    }
  });
}
