/** Calendar events: local store + Google calendars (via integrations/google contract). */
import type { CalendarEvent } from '@monarch/shared';
import { activity, changed, HttpError, newId } from '../kernel.ts';
import {
  createGoogleEvent,
  deleteGoogleEvent,
  googleFreeBusy,
  listGoogleAccounts,
  listGoogleEvents,
  listGoogleEventsDetailed,
  respondGoogleEvent,
  updateGoogleEvent,
  type CalendarAccountResult,
  type CreateEventOpts,
  type RsvpResponse,
  type SendUpdates,
} from '../integrations/google/index.ts';
import { getSettings } from '../settings.ts';
import { serviceStore } from './persist.ts';
import { addDays, isoOrNull, startOfDay } from './dates.ts';

const store = serviceStore<CalendarEvent[]>('events', []);

export type EventInput = Partial<Omit<CalendarEvent, 'id' | 'source'>>;

const byStart = (a: CalendarEvent, b: CalendarEvent) => Date.parse(a.start) - Date.parse(b.start);

function overlaps(ev: CalendarEvent, from: number, to: number): boolean {
  const s = Date.parse(ev.start);
  const e = ev.end ? Date.parse(ev.end) : s + (ev.allDay ? 86400e3 : 0);
  return s < to && Math.max(e, s) >= from;
}

export function defaultRange(): { from: Date; to: Date } {
  const from = startOfDay();
  return { from, to: addDays(from, 30) };
}

export function listLocalEvents(from: Date, to: Date): CalendarEvent[] {
  return store
    .get()
    .filter((e) => overlaps(e, from.getTime(), to.getTime()))
    .sort(byStart);
}

/** local + every connected google account; google failures are logged and ignored */
export async function listEvents(from: Date, to: Date, opts: { googleTimeoutMs?: number } = {}): Promise<CalendarEvent[]> {
  const local = listLocalEvents(from, to);
  let google: CalendarEvent[] = [];
  try {
    const p = listGoogleEvents(from, to);
    google = opts.googleTimeoutMs
      ? await Promise.race([p, new Promise<CalendarEvent[]>((r) => setTimeout(() => r([]), opts.googleTimeoutMs).unref())])
      : await p;
  } catch (e) {
    console.warn('[events] google calendar listing failed:', (e as Error).message);
  }
  return [...local, ...google].sort(byStart);
}

/** local + google events plus what was checked: local count and one result per Google account (count or error) */
export async function listEventsWithCoverage(
  from: Date,
  to: Date,
): Promise<{ events: CalendarEvent[]; local: number; google: CalendarAccountResult[]; googleError?: string }> {
  const local = listLocalEvents(from, to);
  try {
    const g = await listGoogleEventsDetailed(from, to);
    return { events: [...local, ...g.events].sort(byStart), local: local.length, google: g.accounts };
  } catch (e) {
    return { events: local, local: local.length, google: [], googleError: (e as Error).message || String(e) };
  }
}

function normalize(input: EventInput, base?: CalendarEvent): Omit<CalendarEvent, 'id' | 'source'> {
  const title = (input.title ?? base?.title ?? '').trim();
  if (!title) throw new HttpError(400, 'title is required');
  const start = input.start !== undefined ? isoOrNull(input.start) : base?.start;
  if (!start) throw new HttpError(400, 'start is required (ISO-8601)');
  const end = input.end !== undefined ? isoOrNull(input.end) : base?.end;
  if (end && Date.parse(end) < Date.parse(start)) throw new HttpError(400, 'end must be after start');
  return {
    accountId: input.accountId ?? base?.accountId,
    calendarId: input.calendarId ?? base?.calendarId,
    title,
    start,
    end: end ?? null,
    allDay: input.allDay ?? base?.allDay ?? false,
    location: (input.location ?? base?.location)?.trim() || undefined,
    notes: (input.notes ?? base?.notes)?.trim() || undefined,
    link: (input.link ?? base?.link)?.trim() || undefined,
  };
}

export async function createEvent(input: EventInput, opts: CreateEventOpts = {}): Promise<CalendarEvent> {
  const data = normalize(input);
  if (!data.accountId && (opts.attendees?.length || opts.createMeet)) throw new HttpError(400, 'attendees / createMeet need a Google accountId');
  if (data.accountId) {
    const ev = await createGoogleEvent(data, opts);
    changed('events');
    activity('CAL', `Event added to Google calendar: ${ev.title}`);
    return ev;
  }
  const ev: CalendarEvent = { ...data, id: newId(), source: 'local' };
  delete ev.accountId;
  store.update((a) => {
    a.push(ev);
  });
  changed('events');
  activity('CAL', `Event added: ${ev.title}`);
  return ev;
}

const findLocal = (id: string) => store.get().find((e) => e.id === id);

export async function updateEvent(id: string, patch: EventInput, opts: { sendUpdates?: SendUpdates } = {}): Promise<CalendarEvent> {
  const local = findLocal(id);
  if (local) {
    const next = normalize(patch, local);
    Object.assign(local, next);
    delete local.accountId;
    store.save();
    changed('events');
    return local;
  }
  if (id.includes(':')) {
    const ev = await updateGoogleEvent(id, patch, opts);
    changed('events');
    return ev;
  }
  throw new HttpError(404, `Event ${id} not found`);
}

export async function deleteEvent(id: string): Promise<void> {
  const local = findLocal(id);
  if (local) {
    store.update((a) => a.filter((e) => e.id !== id));
    changed('events');
    activity('CAL', `Event deleted: ${local.title}`);
    return;
  }
  if (id.includes(':')) {
    await deleteGoogleEvent(id);
    changed('events');
    activity('CAL', `Google event deleted`);
    return;
  }
  throw new HttpError(404, `Event ${id} not found`);
}

/** RSVP to a Google invitation (local events have no guests) */
export async function respondToEvent(id: string, response: RsvpResponse, opts: { comment?: string; notify?: boolean } = {}): Promise<CalendarEvent> {
  if (findLocal(id) || !id.includes(':')) throw new HttpError(400, 'Only Google calendar invitations can be answered');
  return respondGoogleEvent(id, response, opts);
}

/* ─────────────── free slots ─────────────── */

export function userTimeZone(): string {
  try {
    const tz = getSettings().user.location?.timezone;
    if (tz) {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    }
  } catch {
    /* invalid tz → fall back */
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** wall-clock parts of an instant in tz */
function partsIn(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, min: +o.minute, s: +o.second, wd: o.weekday };
}
/** instant for wall-clock y-m-d hh:mm in tz */
function zoned(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  let t = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(t), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    t += Date.UTC(y, m - 1, d, hh, mm) - asUtc;
  }
  return new Date(t);
}

export interface FreeSlotsInput {
  from?: Date;
  to?: Date;
  durationMinutes: number;
  attendees?: string[];
  workingHours?: { start: string; end: string };
  /** Google account ids/emails whose calendars count as the user's busy time (default: all) */
  accounts?: string[];
  includeWeekends?: boolean;
  maxSlots?: number;
}
export interface FreeSlot {
  start: string;
  end: string;
  minutes: number;
}
export interface FreeSlotsResult {
  timeZone: string;
  slots: FreeSlot[];
  checked: string[];
  /** user accounts that could not be read */
  accountErrors: { email: string; error: string }[];
  /** attendees whose calendars were readable */
  attendeesChecked: string[];
  /** attendees whose free/busy is unknown (external / not shared) */
  attendeesUnavailable: { email: string; reason: string }[];
}

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** free windows (≥ duration) inside working hours on weekdays, across local + all Google calendars + attendees' free/busy */
export async function findFreeSlots(i: FreeSlotsInput): Promise<FreeSlotsResult> {
  const tz = userTimeZone();
  const dur = i.durationMinutes * 60_000;
  if (!(dur > 0)) throw new HttpError(400, 'durationMinutes must be > 0');
  const wh = i.workingHours ?? { start: '09:00', end: '18:00' };
  const ws = HM.exec(wh.start), we = HM.exec(wh.end);
  if (!ws || !we) throw new HttpError(400, 'workingHours must be HH:MM');
  const now = new Date();
  const from = i.from && i.from > now ? i.from : now;
  const to = i.to ?? addDays(from, 7);
  if (to <= from) throw new HttpError(400, '"to" must be after "from"');

  const busy: [number, number][] = [];
  // local events (timed only; point events block 30 min)
  for (const e of listLocalEvents(from, to)) {
    if (e.allDay) continue;
    const s = Date.parse(e.start);
    busy.push([s, e.end ? Date.parse(e.end) : s + 30 * 60_000]);
  }
  const res: FreeSlotsResult = { timeZone: tz, slots: [], checked: ['local Monarch calendar'], accountErrors: [], attendeesChecked: [], attendeesUnavailable: [] };
  const want = i.accounts?.map((a) => a.toLowerCase());
  const accts = listGoogleAccounts().filter((a) => !want || want.includes(a.id.toLowerCase()) || want.includes(a.email.toLowerCase()));
  if (want && !accts.length) throw new HttpError(400, `No connected Google account matches ${i.accounts!.join(', ')}`);
  const own = new Set(listGoogleAccounts().map((a) => a.email.toLowerCase()));
  const add = (list: { start: string; end: string }[]) => {
    for (const b of list) busy.push([Date.parse(b.start), Date.parse(b.end)]);
  };
  const healthy: typeof accts = [];
  await Promise.all(
    accts.map(async (a) => {
      if (a.error) return void res.accountErrors.push({ email: a.email, error: a.error });
      try {
        const r = await googleFreeBusy(a.id, ['primary'], from, to, tz);
        if (r.errors.primary) throw new Error(r.errors.primary);
        add(r.busy.primary ?? []);
        res.checked.push(a.email);
        healthy.push(a);
      } catch (e) {
        res.accountErrors.push({ email: a.email, error: (e as Error).message });
      }
    }),
  );
  const guests = [...new Set((i.attendees ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))].filter((g) => !own.has(g));
  if (guests.length) {
    // query through the account in the same domain as the guest when possible, else the first healthy one
    const ordered = [...healthy].sort((x, y) => x.email.localeCompare(y.email));
    const via = new Map<string, string[]>();
    for (const g of guests) {
      const dom = g.split('@')[1];
      const a = ordered.find((x) => x.email.toLowerCase().endsWith(`@${dom}`)) ?? ordered[0];
      if (!a) {
        res.attendeesUnavailable.push({ email: g, reason: 'no readable Google account to query free/busy' });
        continue;
      }
      via.set(a.id, [...(via.get(a.id) ?? []), g]);
    }
    await Promise.all(
      [...via].map(async ([acctId, ids]) => {
        try {
          const r = await googleFreeBusy(acctId, ids, from, to, tz);
          for (const g of ids) {
            if (r.errors[g]) res.attendeesUnavailable.push({ email: g, reason: r.errors[g] });
            else {
              add(r.busy[g] ?? []);
              res.attendeesChecked.push(g);
            }
          }
        } catch (e) {
          for (const g of ids) res.attendeesUnavailable.push({ email: g, reason: (e as Error).message });
        }
      }),
    );
  }

  busy.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const b of busy) {
    if (!(b[1] > b[0])) continue;
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
    else merged.push([...b]);
  }

  const max = i.maxSlots ?? 8;
  const step = 15 * 60_000;
  const p0 = partsIn(from, tz);
  for (let day = 0; res.slots.length < max; day++) {
    const noon = zoned(p0.y, p0.m, p0.d, 12, 0, tz);
    const dp = partsIn(new Date(noon.getTime() + day * 86400e3), tz);
    const dayStart = zoned(dp.y, dp.m, dp.d, +ws[1], +ws[2], tz).getTime();
    if (dayStart >= to.getTime()) break;
    if (!i.includeWeekends && (dp.wd === 'Sat' || dp.wd === 'Sun')) continue;
    const dayEnd = Math.min(zoned(dp.y, dp.m, dp.d, +we[1], +we[2], tz).getTime(), to.getTime());
    let cur = Math.max(dayStart, from.getTime());
    cur = Math.ceil(cur / step) * step;
    const emit = (s: number, e: number) => {
      if (e - s >= dur && res.slots.length < max) res.slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), minutes: Math.round((e - s) / 60_000) });
    };
    for (const [bs, be] of merged) {
      if (be <= cur) continue;
      if (bs >= dayEnd) break;
      emit(cur, Math.min(bs, dayEnd));
      cur = Math.max(cur, be);
    }
    if (cur < dayEnd) emit(cur, dayEnd);
  }
  return res;
}
