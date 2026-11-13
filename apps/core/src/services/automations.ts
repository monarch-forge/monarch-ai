/**
 * Automations: scheduled prompts that run in their own agent session.
 * Schedules: 5-field cron ("0 8 * * 1-5") or shorthand "every 30m" | "every 2h" | "every 1d" | "daily 08:00" |
 * "weekdays 08:00" | "hourly". Cron-expressible schedules use croner; odd intervals ("every 45m") use a ticker.
 */
import { Cron } from 'croner';
import type { Automation } from '@monarch/shared';
import { activity, bus, changed, HttpError, newId, notify, nowIso } from '../kernel.ts';
import { runPrompt } from '../agent/orchestrator.ts';
import { serviceStore } from './persist.ts';

const store = serviceStore<Automation[]>('automations', []);

export interface ParsedSchedule {
  cron?: string;
  intervalMs?: number;
}

const UNIT: Record<string, number> = { m: 60e3, h: 3600e3, d: 86400e3 };

/** parse a schedule expression; throws HttpError(400) when invalid */
export function parseSchedule(expr: string): ParsedSchedule {
  const s = String(expr ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) throw new HttpError(400, 'schedule is required');
  if (s === 'hourly') return { cron: '0 * * * *' };
  const every = /^every (\d+) ?(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(s);
  if (every) {
    const n = Number(every[1]);
    const u = every[2].startsWith('mi') || every[2] === 'm' ? 'm' : every[2][0];
    if (n < 1) throw new HttpError(400, 'interval must be at least 1');
    if (u === 'm' && n < 60 && 60 % n === 0) return { cron: n === 1 ? '* * * * *' : `*/${n} * * * *` };
    if (u === 'm' && n === 60) return { cron: '0 * * * *' };
    if (u === 'h' && n < 24 && 24 % n === 0) return { cron: n === 1 ? '0 * * * *' : `0 */${n} * * *` };
    if ((u === 'h' && n === 24) || (u === 'd' && n === 1)) return { cron: '0 0 * * *' };
    return { intervalMs: n * UNIT[u] };
  }
  const daily = /^(daily|weekdays|weekends) (?:at )?(\d{1,2}):(\d{2})$/.exec(s);
  if (daily) {
    const h = Number(daily[2]);
    const m = Number(daily[3]);
    if (h > 23 || m > 59) throw new HttpError(400, `invalid time in "${expr}"`);
    const dow = daily[1] === 'weekdays' ? '1-5' : daily[1] === 'weekends' ? '0,6' : '*';
    return { cron: `${m} ${h} * * ${dow}` };
  }
  if (s.split(' ').length === 5) {
    try {
      const probe = new Cron(s, { paused: true, mode: '5-part' });
      probe.stop();
      return { cron: s };
    } catch (e) {
      throw new HttpError(400, `invalid cron "${expr}": ${(e as Error).message}`);
    }
  }
  throw new HttpError(400, `unrecognized schedule "${expr}" — use 5-field cron or "every 30m" | "every 2h" | "daily 08:00"`);
}

function computeNext(a: Automation, now = Date.now()): string | null {
  if (!a.enabled) return null;
  const p = parseSchedule(a.schedule);
  if (p.cron) {
    const c = new Cron(p.cron, { paused: true, mode: '5-part' });
    const next = c.nextRun();
    c.stop();
    return next ? next.toISOString() : null;
  }
  const last = a.lastRunAt ? Date.parse(a.lastRunAt) : NaN;
  const next = Number.isNaN(last) ? now + p.intervalMs! : Math.max(last + p.intervalMs!, now + 30e3);
  return new Date(next).toISOString();
}

/* ─────────────── scheduler ─────────────── */

const jobs = new Map<string, Cron>();
const running = new Set<string>();
let started = false;

function unschedule(id: string): void {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

/** (re)arm one automation and refresh its nextRunAt (does not save) */
function arm(a: Automation): void {
  unschedule(a.id);
  try {
    a.nextRunAt = computeNext(a);
  } catch {
    a.nextRunAt = null;
    return;
  }
  if (!started || !a.enabled) return;
  const p = parseSchedule(a.schedule);
  if (p.cron) {
    const job = new Cron(p.cron, { mode: '5-part', catch: true }, () => {
      if (running.has(a.id)) {
        activity('AUTO', `Skipped "${a.name}" — previous run still in progress`, 'warn');
        return;
      }
      execute(a.id).done.catch(() => {});
    });
    jobs.set(a.id, job);
  }
}

/** called by the scheduler ticker: fire interval-based automations that are due */
export function tickIntervalAutomations(now = Date.now()): void {
  for (const a of store.get()) {
    if (!a.enabled || running.has(a.id) || jobs.has(a.id) || !a.nextRunAt) continue;
    if (Date.parse(a.nextRunAt) <= now) execute(a.id).done.catch(() => {});
  }
}

export function startAutomations(): void {
  started = true;
  for (const a of store.get()) arm(a);
  store.save();
}

export function stopAutomations(): void {
  started = false;
  for (const id of [...jobs.keys()]) unschedule(id);
}

/* ─────────────── execution ─────────────── */

export interface RunHandle {
  /** resolves with the session id as soon as the orchestrator announces it (or when the run ends) */
  session: Promise<string | null>;
  done: Promise<{ sessionId: string; text: string; error?: string }>;
}

function execute(id: string): RunHandle {
  const a = getAutomation(id);
  running.add(id);
  const startedAt = Date.now();
  activity('AUTO', `Running automation "${a.name}"`);
  let resolveSession!: (sid: string | null) => void;
  const session = new Promise<string | null>((r) => (resolveSession = r));
  const off = bus.onServerEvent((ev) => {
    if (
      ev.type === 'session.updated' &&
      ev.session.kind === 'automation' &&
      ev.session.title === a.name &&
      Date.parse(ev.session.createdAt) >= startedAt - 2000
    ) {
      off();
      resolveSession(ev.session.id);
    }
  });
  const done = (async () => {
    let r: { sessionId: string; text: string; error?: string };
    try {
      r = await runPrompt({ kind: 'automation', text: a.prompt, title: a.name });
    } catch (e) {
      r = { sessionId: '', text: '', error: (e as Error)?.message || String(e) };
    } finally {
      off();
      running.delete(id);
    }
    resolveSession(r.sessionId || null);
    const result = (r.error ? `Error: ${r.error}` : r.text || '(no output)').trim();
    const cur = store.get().find((x) => x.id === id);
    if (cur) {
      cur.lastRunAt = nowIso();
      cur.lastStatus = r.error ? 'error' : 'ok';
      cur.lastResult = result.length > 2000 ? `${result.slice(0, 2000)}…` : result;
      if (!jobs.has(id)) arm(cur);
      else cur.nextRunAt = jobs.get(id)!.nextRun()?.toISOString() ?? null;
      store.save();
      changed('automations');
      if (cur.notify) notify(cur.name, result.length > 600 ? `${result.slice(0, 600)}…` : result, r.error ? 'error' : 'success');
    }
    activity('AUTO', r.error ? `"${a.name}" failed: ${r.error}` : `"${a.name}" completed`, r.error ? 'error' : 'info', r.sessionId || undefined);
    return r;
  })();
  return { session, done };
}

/** run now (manual trigger); resolves with the session id as soon as it is known */
export async function runAutomationNow(id: string): Promise<{ sessionId: string }> {
  getAutomation(id);
  if (running.has(id)) throw new HttpError(409, 'automation is already running');
  const h = execute(id);
  h.done.catch(() => {});
  const sid = await h.session;
  if (sid) return { sessionId: sid };
  const r = await h.done;
  throw new HttpError(500, r.error || 'automation run did not start a session');
}

/* ─────────────── CRUD ─────────────── */

export function listAutomations(): Automation[] {
  return [...store.get()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getAutomation(id: string): Automation {
  const a = store.get().find((x) => x.id === id);
  if (!a) throw new HttpError(404, `Automation ${id} not found`);
  return a;
}

export type AutomationInput = Partial<Pick<Automation, 'name' | 'schedule' | 'prompt' | 'enabled' | 'notify'>>;

export function createAutomation(input: AutomationInput): Automation {
  const name = input.name?.trim();
  const prompt = input.prompt?.trim();
  if (!name) throw new HttpError(400, 'name is required');
  if (!prompt) throw new HttpError(400, 'prompt is required');
  parseSchedule(input.schedule ?? '');
  const a: Automation = {
    id: newId(),
    name,
    schedule: input.schedule!.trim(),
    prompt,
    enabled: input.enabled ?? true,
    notify: input.notify ?? true,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    lastResult: null,
    createdAt: nowIso(),
  };
  arm(a);
  store.update((arr) => {
    arr.push(a);
  });
  changed('automations');
  activity('AUTO', `Automation created: ${a.name} (${a.schedule})`);
  return a;
}

export function updateAutomation(id: string, patch: AutomationInput): Automation {
  const a = getAutomation(id);
  if (patch.schedule !== undefined) {
    parseSchedule(patch.schedule);
    a.schedule = patch.schedule.trim();
  }
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new HttpError(400, 'name cannot be empty');
    a.name = patch.name.trim();
  }
  if (patch.prompt !== undefined) {
    if (!patch.prompt.trim()) throw new HttpError(400, 'prompt cannot be empty');
    a.prompt = patch.prompt.trim();
  }
  if (patch.enabled !== undefined) a.enabled = !!patch.enabled;
  if (patch.notify !== undefined) a.notify = !!patch.notify;
  arm(a);
  store.save();
  changed('automations');
  return a;
}

export function deleteAutomation(id: string): Automation {
  const a = getAutomation(id);
  unschedule(id);
  store.update((arr) => arr.filter((x) => x.id !== id));
  changed('automations');
  activity('AUTO', `Automation deleted: ${a.name}`);
  return a;
}
