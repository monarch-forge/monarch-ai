/** System routes: settings, briefing, activity, notifications, system/*, weather, geocode, usage, fs/dirs, coding/git. */
import type { Hono } from 'hono';
import type { Settings, UsageReport } from '@monarch/shared';
import { changed, HttpError, isPlainObject, notifications, recentActivity } from '../kernel.ts';
import { getSettings, updateSettings } from '../settings.ts';
import { buildBriefing } from '../services/briefing.ts';
import { getMetrics, systemInfo, topProcesses } from '../services/metrics.ts';
import { geocode, getWeather } from '../services/weather.ts';
import { usageReport } from '../services/usage.ts';
import { gitSummary, listDirs } from '../services/workspace.ts';
import { readJson } from '../services/http.ts';

const MASK = '••••••••';

/** never ship stored custom-model API keys to the UI */
function publicSettings(s: Settings): Settings {
  const pi = { ...s.pi };
  pi.customProviders = (s.pi.customProviders ?? []).map((p) => ({
    ...p,
    models: (p.models ?? []).map((m) => (m.apiKey ? { ...m, apiKey: MASK } : m)),
  }));
  delete pi.customModels;
  delete pi.customBaseUrl;
  return { ...s, pi };
}

/** keep existing per-model keys when the UI echoes the mask back */
function restoreMaskedKeys(patch: Record<string, any>): Record<string, any> {
  const provs = patch?.pi?.customProviders;
  if (!Array.isArray(provs)) return patch;
  const existing = new Map((getSettings().pi.customProviders ?? []).map((p) => [p.id, new Map((p.models ?? []).map((m) => [m.id, m.apiKey]))]));
  return {
    ...patch,
    pi: {
      ...patch.pi,
      customProviders: provs.map((p: any) =>
        isPlainObject(p) && Array.isArray(p.models)
          ? { ...p, models: p.models.map((m: any) => (isPlainObject(m) && m.apiKey === MASK ? { ...m, apiKey: existing.get(p.id)?.get(m.id) } : m)) }
          : p,
      ),
    },
  };
}

const intParam = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function register(app: Hono): void {
  app.get('/api/settings', (c) => c.json(publicSettings(getSettings())));
  app.put('/api/settings', async (c) => {
    const body = await readJson(c);
    if (!isPlainObject(body)) throw new HttpError(400, 'settings patch must be an object');
    return c.json(publicSettings(updateSettings(restoreMaskedKeys(body))));
  });

  app.get('/api/briefing', async (c) => c.json(await buildBriefing()));

  app.get('/api/activity', (c) => c.json(recentActivity(intParam(c.req.query('limit'), 50, 1, 500))));

  app.get('/api/notifications', (c) => c.json(notifications.get()));
  app.post('/api/notifications/read', (c) => {
    let n = 0;
    notifications.update((a) => {
      for (const x of a)
        if (!x.read) {
          x.read = true;
          n++;
        }
    });
    if (n) changed('notifications');
    return c.json({ ok: true });
  });

  app.get('/api/system/info', async (c) => c.json(await systemInfo()));
  app.get('/api/system/metrics', async (c) => c.json(await getMetrics()));
  app.get('/api/system/processes', async (c) => {
    const sort = c.req.query('sort') === 'mem' ? 'mem' : 'cpu';
    return c.json(await topProcesses(intParam(c.req.query('limit'), 15, 1, 200), sort));
  });

  app.get('/api/weather', async (c) => {
    const loc = getSettings().user.location;
    if (!loc) throw new HttpError(404, 'No location set — choose one in Config');
    return c.json(await getWeather(loc, { fresh: c.req.query('fresh') === '1' }));
  });
  app.get('/api/geocode', async (c) => c.json(await geocode(c.req.query('q') ?? '')));

  app.get('/api/usage', (c) => {
    const r = c.req.query('range');
    const range: UsageReport['range'] = r === '7d' || r === '30d' ? r : '24h';
    return c.json(usageReport(range));
  });

  app.get('/api/fs/dirs', async (c) => {
    const hidden = ['1', 'true'].includes(c.req.query('hidden') ?? '');
    return c.json(await listDirs(c.req.query('path'), { hidden }));
  });
  app.get('/api/coding/git', async (c) => c.json(await gitSummary(c.req.query('cwd'))));
}
