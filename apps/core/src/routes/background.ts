/** Background agent + morning brief routes — see protocol.ts BackgroundStatus / MorningBrief. */
import type { Hono } from 'hono';
import { readJson } from '../services/http.ts';
import { backgroundStatus, latestBrief, runBackgroundJob, updateBackground } from '../services/background.ts';

export function register(app: Hono): void {
  app.get('/api/brief', (c) => c.json(latestBrief()));
  app.get('/api/background', (c) => c.json(backgroundStatus()));
  app.patch('/api/background', async (c) => c.json(updateBackground(await readJson(c))));
  app.post('/api/background/:job/run', async (c) => c.json(await runBackgroundJob(c.req.param('job'))));
}
