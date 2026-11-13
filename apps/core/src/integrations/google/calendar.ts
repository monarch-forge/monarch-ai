/** Google Calendar v3 (primary calendar of each connected account). */
import type { CalendarEvent } from '@monarch/shared';
import { HttpError, activity, changed } from '../../kernel.ts';
import { googleFetch, listAccounts, resolveAccount } from './auth.ts';

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

interface GEventTime {
  date?: string; // all-day: YYYY-MM-DD
  dateTime?: string;
  timeZone?: string;
}
export interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GEventTime;
  end?: GEventTime;
  hangoutLink?: string;
  htmlLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

const MEETING_URL = /https?:\/\/(?:[\w-]+\.)*(?:zoom\.us\/(?:j|my|w)\/|meet\.google\.com\/|teams\.microsoft\.com\/l\/meetup-join\/|teams\.live\.com\/meet\/|[\w-]+\.webex\.com\/|whereby\.com\/|meet\.jit\.si\/)[^\s"'<>)]*/i;

/** local-midnight ISO for a YYYY-MM-DD date */
function dateToIso(d: string): string {
  return new Date(`${d}T00:00:00`).toISOString();
}
function isoToLocalDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function meetingLink(e: GEvent): string | undefined {
  if (e.hangoutLink) return e.hangoutLink;
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video' && p.uri);
  if (video?.uri) return video.uri;
  for (const s of [e.location, e.description]) {
    const m = s?.match(MEETING_URL);
    if (m) return m[0];
  }
  return undefined;
}

export function toCalendarEvent(accountId: string, e: GEvent): CalendarEvent {
  const allDay = !!e.start?.date && !e.start?.dateTime;
  const start = allDay ? dateToIso(e.start!.date!) : (e.start?.dateTime ? new Date(e.start.dateTime).toISOString() : new Date(0).toISOString());
  const end = allDay ? (e.end?.date ? dateToIso(e.end.date) : null) : e.end?.dateTime ? new Date(e.end.dateTime).toISOString() : null;
  const ev: CalendarEvent = {
    id: `${accountId}:${e.id}`,
    source: 'google',
    accountId,
    calendarId: 'primary',
    title: e.summary || '(no title)',
    start,
    end,
    allDay,
  };
  if (e.location) ev.location = e.location;
  if (e.description) ev.notes = e.description;
  const link = meetingLink(e);
  if (link) ev.link = link;
  return ev;
}

function splitId(id: string): { accountId: string; eventId: string } {
  const i = id.indexOf(':');
  if (i <= 0 || i === id.length - 1) throw new HttpError(400, `Invalid Google event id "${id}" (expected accountId:eventId)`);
  return { accountId: id.slice(0, i), eventId: id.slice(i + 1) };
}

/** body for insert/patch from a (partial) CalendarEvent */
export function toGoogleBody(ev: Partial<CalendarEvent>, existing?: { allDay: boolean; start?: string; end?: string | null }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (ev.title !== undefined) body.summary = ev.title;
  if (ev.location !== undefined) body.location = ev.location;
  if (ev.notes !== undefined) body.description = ev.notes;
  const timeTouched = ev.start !== undefined || ev.end !== undefined || ev.allDay !== undefined;
  if (timeTouched) {
    const allDay = ev.allDay ?? existing?.allDay ?? false;
    const startIso = ev.start ?? existing?.start;
    if (!startIso || Number.isNaN(new Date(startIso).getTime())) throw new HttpError(400, 'A valid start time is required');
    let endIso = ev.end !== undefined ? ev.end : existing?.end;
    if (allDay) {
      const sd = isoToLocalDate(startIso);
      let ed = endIso ? isoToLocalDate(endIso) : sd;
      if (ed <= sd) {
        const d = new Date(`${sd}T00:00:00`);
        d.setDate(d.getDate() + 1);
        ed = isoToLocalDate(d.toISOString());
      }
      body.start = { date: sd };
      body.end = { date: ed };
    } else {
      const s = new Date(startIso);
      const e = endIso ? new Date(endIso) : new Date(s.getTime() + 60 * 60_000);
      if (e <= s) e.setTime(s.getTime() + 30 * 60_000);
      body.start = { dateTime: s.toISOString() };
      body.end = { dateTime: e.toISOString() };
    }
  }
  return body;
}

export async function listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  const accounts = listAccounts().filter((a) => !a.error);
  if (!accounts.length) return [];
  const per = await Promise.all(
    accounts.map(async (a) => {
      try {
        const out: CalendarEvent[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 5; page++) {
          const r = await googleFetch<{ items?: GEvent[]; nextPageToken?: string }>(a.id, CAL, {
            query: {
              timeMin: from.toISOString(),
              timeMax: to.toISOString(),
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 250,
              pageToken,
            },
          });
          for (const e of r.items ?? []) if (e.status !== 'cancelled') out.push(toCalendarEvent(a.id, e));
          pageToken = r.nextPageToken;
          if (!pageToken) break;
        }
        return out;
      } catch (e) {
        console.warn(`[calendar] ${a.email}: ${(e as Error).message}`);
        return [];
      }
    }),
  );
  return per.flat().sort((x, y) => x.start.localeCompare(y.start));
}

export async function createEvent(ev: Omit<CalendarEvent, 'id' | 'source'>): Promise<CalendarEvent> {
  const acct = resolveAccount(ev.accountId);
  if (!ev.title?.trim()) throw new HttpError(400, 'Event title is required');
  const body = toGoogleBody({ ...ev, start: ev.start, allDay: ev.allDay ?? false });
  const r = await googleFetch<GEvent>(acct.id, CAL, { method: 'POST', body });
  changed('events');
  activity('CAL', `Event created in ${acct.email}: ${ev.title}`);
  return toCalendarEvent(acct.id, r);
}

export async function updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
  const { accountId, eventId } = splitId(id);
  const acct = resolveAccount(accountId);
  let existing: { allDay: boolean; start?: string; end?: string | null } | undefined;
  if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
    const cur = toCalendarEvent(acct.id, await googleFetch<GEvent>(acct.id, `${CAL}/${encodeURIComponent(eventId)}`));
    existing = { allDay: !!cur.allDay, start: cur.start, end: cur.end };
  }
  const body = toGoogleBody(patch, existing);
  const r = await googleFetch<GEvent>(acct.id, `${CAL}/${encodeURIComponent(eventId)}`, { method: 'PATCH', body });
  changed('events');
  activity('CAL', `Event updated: ${r.summary ?? eventId}`);
  return toCalendarEvent(acct.id, r);
}

export async function deleteEvent(id: string): Promise<void> {
  const { accountId, eventId } = splitId(id);
  const acct = resolveAccount(accountId);
  try {
    await googleFetch(acct.id, `${CAL}/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  } catch (e) {
    // 410 Gone (already deleted) is reported as 502 by googleFetch; treat "deleted" messages as success
    if (!/410|deleted/i.test((e as Error).message)) throw e;
  }
  changed('events');
  activity('CAL', `Event deleted (${acct.email})`);
}
