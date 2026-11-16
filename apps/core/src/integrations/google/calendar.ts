/** Google Calendar v3 (primary calendar of each connected account). */
import type { CalendarEvent } from '@monarch/shared';
import { HttpError, activity, changed } from '../../kernel.ts';
import { googleFetch, listAccounts, resolveAccount } from './auth.ts';

const CAL_API = 'https://www.googleapis.com/calendar/v3';
let calBase = CAL_API;
/** test hook: override the Calendar API base (e.g. a local mock server) */
export function _setGoogleCalendarBase(url: string): void {
  calBase = url.replace(/\/$/, '');
}
const eventsUrl = () => `${calBase}/calendars/primary/events`;

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
  organizer?: { email?: string; self?: boolean; displayName?: string };
  attendees?: GAttendee[];
}
export interface GAttendee {
  email?: string;
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  comment?: string;
  displayName?: string;
  optional?: boolean;
}

/** Google "sendUpdates" query value: who gets notification emails for a change */
export type SendUpdates = 'all' | 'externalOnly' | 'none';


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
  const humans = (e.attendees ?? []).filter((a) => !a.resource);
  if (e.organizer?.email) ev.organizer = e.organizer.email;
  if (humans.length) {
    ev.attendeeCount = humans.length;
    ev.isOrganizer = !!e.organizer?.self;
    const me = humans.find((a) => a.self);
    if (me?.responseStatus) ev.myResponse = me.responseStatus;
  } else if (e.organizer) {
    ev.isOrganizer = !!e.organizer.self;
  }
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

/** what happened for one Google account during a listing (for coverage reporting) */
export interface CalendarAccountResult {
  accountId: string;
  email: string;
  /** events found in the range (0 = empty calendar, not a missing connection) */
  count: number;
  /** set when the account could not be queried (stored auth error or a failed fetch) */
  error?: string;
}

/** events of every connected account plus a per-account result, so callers can report coverage and failures */
export async function listEventsDetailed(from: Date, to: Date): Promise<{ events: CalendarEvent[]; accounts: CalendarAccountResult[] }> {
  const all = listAccounts();
  const results = await Promise.all(
    all.map(async (a): Promise<{ events: CalendarEvent[]; result: CalendarAccountResult }> => {
      if (a.error) return { events: [], result: { accountId: a.id, email: a.email, count: 0, error: a.error } };
      try {
        const out: CalendarEvent[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 5; page++) {
          const r = await googleFetch<{ items?: GEvent[]; nextPageToken?: string }>(a.id, eventsUrl(), {
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
        return { events: out, result: { accountId: a.id, email: a.email, count: out.length } };
      } catch (e) {
        const msg = (e as Error).message || String(e);
        console.warn(`[calendar] ${a.email}: ${msg}`);
        return { events: [], result: { accountId: a.id, email: a.email, count: 0, error: msg } };
      }
    }),
  );
  return {
    events: results.flatMap((r) => r.events).sort((x, y) => x.start.localeCompare(y.start)),
    accounts: results.map((r) => r.result),
  };
}

export async function listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  return (await listEventsDetailed(from, to)).events;
}

export interface CreateEventOpts {
  /** invitee emails; Google emails them an invitation (sendUpdates=all) */
  attendees?: string[];
  /** attach a new Google Meet link (conferenceDataVersion=1) */
  createMeet?: boolean;
}

export async function createEvent(ev: Omit<CalendarEvent, 'id' | 'source'>, opts: CreateEventOpts = {}): Promise<CalendarEvent> {
  const acct = resolveAccount(ev.accountId);
  if (!ev.title?.trim()) throw new HttpError(400, 'Event title is required');
  const body = toGoogleBody({ ...ev, start: ev.start, allDay: ev.allDay ?? false });
  const attendees = [...new Set((opts.attendees ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))];
  for (const a of attendees) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw new HttpError(400, `Invalid attendee email "${a}"`);
  if (attendees.length) body.attendees = attendees.map((email) => ({ email }));
  if (opts.createMeet) {
    body.conferenceData = { createRequest: { requestId: `monarch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  const r = await googleFetch<GEvent>(acct.id, eventsUrl(), {
    method: 'POST',
    body,
    query: { sendUpdates: attendees.length ? 'all' : 'none', conferenceDataVersion: opts.createMeet ? 1 : undefined },
  });
  changed('events');
  activity('CAL', `Event created in ${acct.email}: ${ev.title}`);
  return toCalendarEvent(acct.id, r);
}

/**
 * Patch an event. sendUpdates defaults to 'none' (attendees are NOT emailed); pass 'all' only when
 * the user asked to notify guests of the change.
 */
export async function updateEvent(id: string, patch: Partial<CalendarEvent>, opts: { sendUpdates?: SendUpdates } = {}): Promise<CalendarEvent> {
  const { accountId, eventId } = splitId(id);
  const acct = resolveAccount(accountId);
  let existing: { allDay: boolean; start?: string; end?: string | null } | undefined;
  if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
    const cur = toCalendarEvent(acct.id, await googleFetch<GEvent>(acct.id, `${eventsUrl()}/${encodeURIComponent(eventId)}`));
    existing = { allDay: !!cur.allDay, start: cur.start, end: cur.end };
  }
  const body = toGoogleBody(patch, existing);
  const r = await googleFetch<GEvent>(acct.id, `${eventsUrl()}/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body,
    query: { sendUpdates: opts.sendUpdates ?? 'none' },
  });
  changed('events');
  activity('CAL', `Event updated: ${r.summary ?? eventId}`);
  return toCalendarEvent(acct.id, r);
}

export async function deleteEvent(id: string): Promise<void> {
  const { accountId, eventId } = splitId(id);
  const acct = resolveAccount(accountId);
  try {
    await googleFetch(acct.id, `${eventsUrl()}/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  } catch (e) {
    // 410 Gone (already deleted) is reported as 502 by googleFetch; treat "deleted" messages as success
    if (!/410|deleted/i.test((e as Error).message)) throw e;
  }
  changed('events');
  activity('CAL', `Event deleted (${acct.email})`);
}

/** fetch one Google event (raw) by composite id */
export async function getEvent(id: string): Promise<CalendarEvent> {
  const { accountId, eventId } = splitId(id);
  const acct = resolveAccount(accountId);
  return toCalendarEvent(acct.id, await googleFetch<GEvent>(acct.id, `${eventsUrl()}/${encodeURIComponent(eventId)}`));
}

export type RsvpResponse = 'accepted' | 'declined' | 'tentative';

/** RSVP to an invitation: sets the account's own attendee responseStatus (organizer is notified by Google). */
export async function respondEvent(id: string, response: RsvpResponse, opts: { comment?: string; notify?: boolean } = {}): Promise<CalendarEvent> {
  const { accountId, eventId } = splitId(id);
  const acct = resolveAccount(accountId);
  const url = `${eventsUrl()}/${encodeURIComponent(eventId)}`;
  const cur = await googleFetch<GEvent>(acct.id, url);
  const attendees = cur.attendees ?? [];
  const email = acct.email.toLowerCase();
  const idx = attendees.findIndex((a) => a.self || a.email?.toLowerCase() === email);
  if (idx < 0) {
    if (cur.organizer?.self) throw new HttpError(400, 'You are the organizer of this event — there is no invitation to respond to');
    throw new HttpError(400, `${acct.email} is not on the guest list of this event`);
  }
  const next = attendees.map((a, i) => (i === idx ? { ...a, responseStatus: response, ...(opts.comment !== undefined ? { comment: opts.comment } : {}) } : a));
  const r = await googleFetch<GEvent>(acct.id, url, {
    method: 'PATCH',
    body: { attendees: next },
    query: { sendUpdates: opts.notify === false ? 'none' : 'all' },
  });
  changed('events');
  activity('CAL', `RSVP ${response}: ${r.summary ?? eventId} (${acct.email})`);
  return toCalendarEvent(acct.id, r);
}

export interface BusyInterval {
  start: string;
  end: string;
}
export interface FreeBusyResult {
  /** calendar id (email or 'primary') → busy intervals */
  busy: Record<string, BusyInterval[]>;
  /** calendar id → reason it could not be read (notFound, no access, …) */
  errors: Record<string, string>;
}

/** Google freeBusy query through one account; ids are calendar ids (attendee emails or 'primary'). */
export async function freeBusy(accountId: string, ids: string[], from: Date, to: Date, timeZone?: string): Promise<FreeBusyResult> {
  const acct = resolveAccount(accountId);
  const out: FreeBusyResult = { busy: {}, errors: {} };
  // API limit: 50 calendars per query
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await googleFetch<{ calendars?: Record<string, { busy?: BusyInterval[]; errors?: { domain?: string; reason?: string }[] }> }>(
      acct.id,
      `${calBase}/freeBusy`,
      { method: 'POST', body: { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone, items: chunk.map((id) => ({ id })) } },
    );
    for (const id of chunk) {
      const c = r.calendars?.[id] ?? r.calendars?.[id.toLowerCase()];
      if (!c) out.errors[id] = 'not returned';
      else if (c.errors?.length) out.errors[id] = c.errors.map((e) => e.reason ?? 'error').join(', ');
      else out.busy[id] = c.busy ?? [];
    }
  }
  return out;
}
