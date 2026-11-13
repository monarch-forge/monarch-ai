/** Productivity routes: tasks, events, automations. */
import type { Hono } from 'hono';
import { HttpError } from '../kernel.ts';
import { createTask, deleteTask, listTasks, updateTask, type TaskInput } from '../services/tasks.ts';
import { createEvent, defaultRange, deleteEvent, listEvents, updateEvent, type EventInput } from '../services/events.ts';
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  runAutomationNow,
  updateAutomation,
  type AutomationInput,
} from '../services/automations.ts';
import { parseWhen } from '../services/dates.ts';
import { readJson } from '../services/http.ts';

export function register(app: Hono): void {
  /* tasks */
  app.get('/api/tasks', (c) => {
    const d = c.req.query('done');
    return c.json(
      listTasks({
        done: d === 'true' || d === '1' ? true : d === 'false' || d === '0' ? false : undefined,
        tag: c.req.query('tag') || undefined,
        q: c.req.query('q') || undefined,
      }),
    );
  });
  app.post('/api/tasks', async (c) => c.json(createTask(await readJson<TaskInput>(c)), 201));
  app.patch('/api/tasks/:id', async (c) => c.json(updateTask(c.req.param('id'), await readJson<TaskInput>(c))));
  app.delete('/api/tasks/:id', (c) => {
    deleteTask(c.req.param('id'));
    return c.json({ ok: true });
  });

  /* events */
  app.get('/api/events', async (c) => {
    const def = defaultRange();
    const from = parseWhen(c.req.query('from')) ?? def.from;
    const to = parseWhen(c.req.query('to')) ?? (c.req.query('from') ? new Date(from.getTime() + 30 * 86400e3) : def.to);
    if (to <= from) throw new HttpError(400, '"to" must be after "from"');
    return c.json(await listEvents(from, to));
  });
  app.post('/api/events', async (c) => c.json(await createEvent(await readJson<EventInput>(c)), 201));
  app.patch('/api/events/:id', async (c) => c.json(await updateEvent(c.req.param('id'), await readJson<EventInput>(c))));
  app.delete('/api/events/:id', async (c) => {
    await deleteEvent(c.req.param('id'));
    return c.json({ ok: true });
  });

  /* automations */
  app.get('/api/automations', (c) => c.json(listAutomations()));
  app.post('/api/automations', async (c) => c.json(createAutomation(await readJson<AutomationInput>(c)), 201));
  app.patch('/api/automations/:id', async (c) => c.json(updateAutomation(c.req.param('id'), await readJson<AutomationInput>(c))));
  app.delete('/api/automations/:id', (c) => {
    deleteAutomation(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/automations/:id/run', async (c) => c.json(await runAutomationNow(c.req.param('id'))));
}
