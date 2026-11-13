/** Calendar events: local store + Google calendars (via integrations/google contract). */
import type { CalendarEvent } from '@monarch/shared';
import { activity, changed, HttpError, newId } from '../kernel.ts';
import { createGoogleEvent, deleteGoogleEvent, listGoogleEvents, updateGoogleEvent } from '../integrations/google/index.ts';
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

export async function createEvent(input: EventInput): Promise<CalendarEvent> {
  const data = normalize(input);
  if (data.accountId) {
    const ev = await createGoogleEvent(data);
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

export async function updateEvent(id: string, patch: EventInput): Promise<CalendarEvent> {
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
    const ev = await updateGoogleEvent(id, patch);
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
