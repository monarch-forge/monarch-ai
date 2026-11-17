/** Projects + repo profiles — see protocol.ts "/api/projects" lines. */
import type { Hono } from 'hono';
import { readJson } from '../services/http.ts';
import { addProject, listProjects, removeProject, rescanProject, setRepoCheck } from '../services/projects.ts';

export function register(app: Hono): void {
  app.get('/api/projects', async (c) => c.json(await listProjects()));
  app.post('/api/projects', async (c) => c.json(await addProject(await readJson(c)), 201));
  app.delete('/api/projects/:id', (c) => {
    removeProject(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/projects/:id/rescan', async (c) => c.json(await rescanProject(c.req.param('id'))));
  app.put('/api/repos/check', async (c) => {
    const b = await readJson<{ path?: string; check?: string }>(c);
    return c.json(setRepoCheck(String(b.path ?? ''), String(b.check ?? '')));
  });
}
