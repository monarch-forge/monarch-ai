/** Morning brief route — see protocol.ts MorningBrief. */
import type { Hono } from 'hono';
import { latestBrief } from '../services/background.ts';

export function register(app: Hono): void {
  app.get('/api/brief', (c) => c.json(latestBrief()));
}
