/** Productivity tools: tasks/reminders, calendar (local + Google), automations. */
import { z } from 'zod';
import type { Automation, CalendarEvent, Task } from '@monarch/shared';
import { defineTool, type ToolDef } from '../kernel.ts';
import { createTask, deleteTask, getTask, listTasks, updateTask } from '../services/tasks.ts';
import { createEvent, deleteEvent, findFreeSlots, listEventsWithCoverage, respondToEvent, updateEvent, userTimeZone } from '../services/events.ts';
import { createAutomation, deleteAutomation, listAutomations, parseSchedule } from '../services/automations.ts';
import { addDays, fmtLocal, localIso, parseWhen, startOfDay } from '../services/dates.ts';

const WHEN =
  'ISO-8601 datetime, preferably with offset (e.g. "2026-11-13T15:00:00+07:00"); without offset it is local time. Also accepts a date "2026-11-13", "now" or relative "in 30m" / "in 2h" / "in 3d".';

const fmtTask = (t: Task) =>
  [
    `[${t.done ? 'x' : ' '}] ${t.title}`,
    `id=${t.id}`,
    t.priority !== 'normal' ? `priority=${t.priority}` : null,
    t.due ? `due=${localIso(new Date(t.due))}` : null,
    t.remindAt ? `remind=${localIso(new Date(t.remindAt))}` : null,
    t.tags.length ? `tags=${t.tags.join(',')}` : null,
    t.notes ? `notes=${JSON.stringify(t.notes.slice(0, 200))}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

/** accountId → email, filled by calendar_list so event lines can name the account */
let accountEmails = new Map<string, string>();

const fmtEvent = (e: CalendarEvent) =>
  [
    `${e.allDay ? `${new Date(e.start).toLocaleDateString('sv')} (all day)` : `${fmtLocal(e.start)}${e.end ? ` – ${fmtLocal(e.end)}` : ''}`}  ${e.title}`,
    `id=${e.id}`,
    e.accountId ? `account=${accountEmails.get(e.accountId) ?? e.accountId} (accountId=${e.accountId})` : `source=${e.source}`,
    e.isOrganizer ? 'role=organizer' : e.myResponse ? `role=guest rsvp=${e.myResponse === 'needsAction' ? 'PENDING' : e.myResponse}` : e.organizer ? `organizer=${e.organizer}` : null,
    e.attendeeCount ? `guests=${e.attendeeCount}` : null,
    e.location ? `location=${e.location}` : null,
    e.link ? `link=${e.link}` : null,
    e.notes ? `notes=${JSON.stringify(e.notes.slice(0, 200))}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

const fmtAutomation = (a: Automation) =>
  [
    `${a.enabled ? '●' : '○'} ${a.name}`,
    `id=${a.id}`,
    `schedule="${a.schedule}"`,
    a.nextRunAt ? `next=${localIso(new Date(a.nextRunAt))}` : null,
    a.lastRunAt ? `last=${localIso(new Date(a.lastRunAt))} (${a.lastStatus ?? '?'})` : null,
    `prompt=${JSON.stringify(a.prompt.slice(0, 160))}`,
  ]
    .filter(Boolean)
    .join(' | ');

/* ─────────────── tasks ─────────────── */

const tasksList = defineTool({
  name: 'tasks_list',
  loading: 'always',
  group: 'productivity',
  keywords: ['todo', 'to-do', 'reminders', 'tasks'],
  description:
    "List the user's tasks (to-dos). By default returns open tasks sorted by due date then priority. Each line includes the task id needed by task_update / task_complete / task_delete.",
  risk: 'safe',
  tag: 'TSK',
  schema: z.object({
    status: z.enum(['open', 'done', 'all']).optional().describe('Which tasks to include (default "open").'),
    tag: z.string().optional().describe('Only tasks with this tag.'),
    query: z.string().optional().describe('Case-insensitive text match on title and notes.'),
    dueBefore: z.string().optional().describe(`Only tasks due before this time. ${WHEN}`),
    limit: z.number().int().min(1).max(200).optional().describe('Max tasks to return (default 50).'),
  }),
  run: ({ status = 'open', tag, query, dueBefore, limit = 50 }) => {
    const list = listTasks({
      done: status === 'all' ? undefined : status === 'done',
      tag,
      q: query,
      dueBefore: parseWhen(dueBefore) ?? undefined,
    });
    if (!list.length) return 'No matching tasks.';
    return `${list.length} task(s):\n${list.slice(0, limit).map(fmtTask).join('\n')}`;
  },
});

const taskFields = {
  notes: z.string().optional().describe('Longer description / details.'),
  due: z.string().nullable().optional().describe(`Due date/time. ${WHEN} null clears it.`),
  remindAt: z
    .string()
    .nullable()
    .optional()
    .describe(`When to fire a reminder notification. ${WHEN} null clears it. Use this for "remind me to …" requests.`),
  priority: z.enum(['low', 'normal', 'high']).optional().describe('Priority (default "normal").'),
  tags: z.array(z.string()).optional().describe('Tags without "#", e.g. ["work","errands"]. Replaces existing tags on update.'),
};

const taskAdd = defineTool({
  name: 'task_add',
  loading: 'always',
  group: 'productivity',
  keywords: ['todo', 'reminder', 'remind me', 'create task'],
  description:
    'Create a task / to-do, optionally with a due date and a reminder. For "remind me to X at T" create a task with remindAt=T. Call get_datetime first if you need to resolve relative dates.',
  risk: 'sensitive',
  tag: 'TSK',
  schema: z.object({ title: z.string().min(1).describe('Short task title.'), ...taskFields }),
  summarize: (i) => `Add task: ${i.title}${i.due ? ` (due ${i.due})` : ''}${i.remindAt ? ` (remind ${i.remindAt})` : ''}`,
  run: (i) => `Created: ${fmtTask(createTask(i))}`,
});

const taskUpdate = defineTool({
  name: 'task_update',
  group: 'productivity',
  keywords: ['edit task', 'reschedule', 'due date', 'priority', 'todo'],
  description: 'Edit an existing task by id (get ids from tasks_list). Only the fields provided are changed.',
  risk: 'sensitive',
  tag: 'TSK',
  schema: z.object({
    id: z.string().describe('Task id.'),
    title: z.string().optional().describe('New title.'),
    done: z.boolean().optional().describe('Mark done (true) or reopen (false).'),
    ...taskFields,
  }),
  summarize: (i) => `Update task ${i.title ?? i.id}`,
  run: ({ id, ...patch }) => `Updated: ${fmtTask(updateTask(id, patch))}`,
});

const taskComplete = defineTool({
  name: 'task_complete',
  loading: 'always',
  group: 'productivity',
  keywords: ['done', 'finish', 'check off', 'todo'],
  description: 'Mark a task as done by id (get ids from tasks_list).',
  risk: 'sensitive',
  tag: 'TSK',
  schema: z.object({ id: z.string().describe('Task id.') }),
  summarize: (i) => {
    try {
      return `Complete task: ${getTask(i.id).title}`;
    } catch {
      return `Complete task ${i.id}`;
    }
  },
  run: ({ id }) => `Completed: ${updateTask(id, { done: true }).title}`,
});

const taskDelete = defineTool({
  name: 'task_delete',
  group: 'productivity',
  keywords: ['remove task', 'todo'],
  description: 'Permanently delete a task by id. Prefer task_complete for finished tasks; only delete when the user asks.',
  risk: 'dangerous',
  tag: 'TSK',
  schema: z.object({ id: z.string().describe('Task id.') }),
  summarize: (i) => {
    try {
      return `Delete task: ${getTask(i.id).title}`;
    } catch {
      return `Delete task ${i.id}`;
    }
  },
  run: ({ id }) => `Deleted task: ${deleteTask(id).title}`,
});

/* ─────────────── calendar ─────────────── */

const calendarList = defineTool({
  name: 'calendar_list',
  loading: 'always',
  group: 'productivity',
  keywords: ['events', 'schedule', 'agenda', 'meetings', 'appointments', 'google calendar'],
  description:
    "List calendar events from the user's local Monarch calendar and ALL connected Google accounts' primary calendars in a time range (default: today through the next 7 days). Output starts with a coverage line naming every account checked with its event count or error: an account with 0 events has an empty calendar in that range, it is NOT disconnected. Each event line includes its id and account.",
  risk: 'safe',
  tag: 'CAL',
  schema: z.object({
    from: z.string().optional().describe(`Range start (default: start of today). ${WHEN}`),
    to: z.string().optional().describe(`Range end, exclusive (default: from + 7 days). ${WHEN}`),
    query: z.string().optional().describe('Case-insensitive filter on title/location/notes.'),
    pendingOnly: z.boolean().optional().describe('Only Google invitations the user has not answered yet (rsvp=PENDING).'),
  }),
  run: async ({ from, to, query, pendingOnly }) => {
    const f = parseWhen(from) ?? startOfDay();
    const t = parseWhen(to) ?? addDays(f, 7);
    const res = await listEventsWithCoverage(f, t);
    accountEmails = new Map(res.google.map((a) => [a.accountId, a.email]));
    let list = res.events;
    const q = query?.toLowerCase();
    if (q) list = list.filter((e) => `${e.title} ${e.location ?? ''} ${e.notes ?? ''}`.toLowerCase().includes(q));
    if (pendingOnly) list = list.filter((e) => e.myResponse === 'needsAction');
    const count = (pred: (e: CalendarEvent) => boolean) => list.filter(pred).length;
    const parts = res.google.map((a) =>
      a.error ? `${a.email} (error: ${a.error.slice(0, 160)})` : `${a.email} (${count((e) => e.accountId === a.accountId)} event${count((e) => e.accountId === a.accountId) === 1 ? '' : 's'})`,
    );
    const coverage = [
      res.googleError
        ? `Google calendars could not be listed: ${res.googleError}`
        : res.google.length
          ? `Checked ${res.google.length} Google calendar${res.google.length === 1 ? '' : 's'}: ${parts.join(', ')}.`
          : 'No Google accounts connected.',
      `Local Monarch calendar: ${count((e) => !e.accountId)} event(s).`,
      q ? `Filter: "${query}".` : '',
      pendingOnly ? 'Filter: pending invitations only.' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const range = `${fmtLocal(f)} → ${fmtLocal(t)}`;
    if (!list.length) return `${coverage}\nNo events between ${range}.`;
    return `${coverage}\n${list.length} event(s) between ${range}:\n${list.map(fmtEvent).join('\n')}`;
  },
});

const calendarAdd = defineTool({
  name: 'calendar_add',
  group: 'productivity',
  keywords: ['create event', 'schedule meeting', 'appointment', 'book', 'google calendar'],
  description:
    "Add a calendar event. Without accountId it goes to the local Monarch calendar; with accountId (a connected Google account id — see calendar_list output) it is created on that account's primary Google calendar. Google only: attendees (emails) are sent invitations; createMeet attaches a Google Meet link. Use calendar_free_slots first to pick a time.",
  // risk is static per tool: kept 'sensitive' (approval-gated); invites are named in the approval summary
  risk: 'sensitive',
  tag: 'CAL',
  schema: z.object({
    title: z.string().min(1).describe('Event title.'),
    start: z.string().describe(`Start. ${WHEN}`),
    end: z.string().optional().describe(`End (optional; omit for point-in-time). ${WHEN}`),
    allDay: z.boolean().optional().describe('All-day event (use a date for start).'),
    location: z.string().optional(),
    notes: z.string().optional(),
    link: z.string().optional().describe('Meeting link URL.'),
    accountId: z.string().optional().describe('Google account id to create the event on; omit for the local calendar.'),
    attendees: z.array(z.string()).optional().describe('Google only: guest emails to invite (they receive an invitation email).'),
    createMeet: z.boolean().optional().describe('Google only: attach a new Google Meet video link.'),
  }),
  summarize: (i) =>
    `Add event: ${i.title} at ${i.start}${i.accountId ? ` (Google ${i.accountId})` : ''}${i.attendees?.length ? ` — invites ${i.attendees.join(', ')}` : ''}${i.createMeet ? ' + Meet' : ''}`,
  run: async ({ attendees, createMeet, ...i }) => `Created: ${fmtEvent(await createEvent(i, { attendees, createMeet }))}`,
});

const calendarDelete = defineTool({
  name: 'calendar_delete',
  group: 'productivity',
  keywords: ['cancel event', 'remove meeting', 'appointment'],
  description: 'Delete a calendar event by id (local or Google, ids from calendar_list). Only when the user asks.',
  risk: 'dangerous',
  tag: 'CAL',
  schema: z.object({ id: z.string().describe('Event id from calendar_list.') }),
  summarize: (i) => `Delete event ${i.id}`,
  run: async ({ id }) => {
    await deleteEvent(id);
    return `Deleted event ${id}.`;
  },
});

const calendarUpdate = defineTool({
  name: 'calendar_update',
  group: 'productivity',
  keywords: ['reschedule', 'move meeting', 'rename event', 'edit event', 'postpone', 'google calendar'],
  description:
    'Edit a calendar event by id (local or Google; ids from calendar_list): move it (start/end), rename, toggle all-day, change location/notes. Only provided fields change; moving start alone keeps the duration only if you also pass end. Google guests are NOT emailed unless notifyGuests=true (set it only when the user asks to notify them).',
  risk: 'sensitive',
  tag: 'CAL',
  schema: z.object({
    id: z.string().describe('Event id from calendar_list.'),
    title: z.string().optional(),
    start: z.string().optional().describe(`New start. ${WHEN}`),
    end: z.string().nullable().optional().describe(`New end. ${WHEN}`),
    allDay: z.boolean().optional(),
    location: z.string().optional(),
    notes: z.string().optional(),
    link: z.string().optional().describe('Meeting link URL (local events only; Google keeps its own link).'),
    notifyGuests: z.boolean().optional().describe('Google: email the change to guests (sendUpdates=all). Default false.'),
  }),
  summarize: (i) =>
    `Update event ${i.id}: ${[i.title && `title "${i.title}"`, i.start && `start ${i.start}`, i.end && `end ${i.end}`, i.allDay !== undefined && `allDay=${i.allDay}`, i.location !== undefined && 'location', i.notes !== undefined && 'notes'].filter(Boolean).join(', ') || 'no changes'}${i.notifyGuests ? ' (notify guests)' : ''}`,
  run: async ({ id, notifyGuests, ...patch }) => {
    const p = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<CalendarEvent>;
    if (!Object.keys(p).length) return 'Nothing to change.';
    return `Updated: ${fmtEvent(await updateEvent(id, p, { sendUpdates: notifyGuests ? 'all' : 'none' }))}`;
  },
});

const calendarRespond = defineTool({
  name: 'calendar_respond',
  group: 'productivity',
  keywords: ['rsvp', 'accept invite', 'decline meeting', 'tentative', 'invitation'],
  description:
    'RSVP to a Google calendar invitation (find pending ones with calendar_list pendingOnly=true). The organizer is notified of the response.',
  risk: 'sensitive',
  tag: 'CAL',
  schema: z.object({
    id: z.string().describe('Google event id from calendar_list.'),
    response: z.enum(['accepted', 'declined', 'tentative']),
    comment: z.string().optional().describe('Optional note to the organizer.'),
  }),
  summarize: (i) => `RSVP ${i.response} to ${i.id}${i.comment ? ` ("${i.comment.slice(0, 60)}")` : ''}`,
  run: async ({ id, response, comment }) => `Responded ${response}: ${fmtEvent(await respondToEvent(id, response, { comment }))}`,
});

const calendarFreeSlots = defineTool({
  name: 'calendar_free_slots',
  group: 'productivity',
  keywords: ['availability', 'free time', 'find a time', 'when am i free', 'schedule meeting', 'free busy'],
  description:
    "Find free time windows of at least durationMinutes across the user's local calendar and ALL connected Google calendars, plus attendees' busy time (Google free/busy — works for colleagues in the same Workspace or who share their calendar; others are reported as unavailable). Weekdays within working hours (default 09:00–18:00) in the user's timezone; default range now → +7 days; up to 8 windows.",
  risk: 'safe',
  tag: 'CAL',
  schema: z.object({
    durationMinutes: z.number().int().min(5).max(24 * 60),
    from: z.string().optional().describe(`Range start (default now). ${WHEN}`),
    to: z.string().optional().describe(`Range end (default from + 7 days). ${WHEN}`),
    attendees: z.array(z.string()).optional().describe('Guest emails whose availability must also be free.'),
    workingHours: z.object({ start: z.string(), end: z.string() }).optional().describe('Local HH:MM, e.g. {"start":"09:00","end":"18:00"}.'),
    accounts: z.array(z.string()).optional().describe("Only count these Google accounts (ids or emails) as the user's busy time; default all."),
    includeWeekends: z.boolean().optional(),
  }),
  run: async (i) => {
    const r = await findFreeSlots({
      ...i,
      from: parseWhen(i.from) ?? undefined,
      to: parseWhen(i.to) ?? undefined,
    });
    const tz = r.timeZone || userTimeZone();
    const fmt = (iso: string, withDay: boolean) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', ...(withDay ? { weekday: 'short', day: '2-digit', month: 'short' } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    const lines = [
      `Timezone ${tz}. Checked: ${r.checked.join(', ')}.`,
      r.accountErrors.length ? `NOT checked (errors): ${r.accountErrors.map((a) => `${a.email} (${a.error.slice(0, 120)})`).join('; ')}.` : '',
      r.attendeesChecked.length ? `Attendees checked: ${r.attendeesChecked.join(', ')}.` : '',
      r.attendeesUnavailable.length ? `Attendee availability UNKNOWN (not included): ${r.attendeesUnavailable.map((a) => `${a.email} (${a.reason})`).join('; ')}.` : '',
    ].filter(Boolean);
    if (!r.slots.length) return `${lines.join('\n')}\nNo free window of ${i.durationMinutes} min found.`;
    return `${lines.join('\n')}\n${r.slots.length} free window(s) ≥ ${i.durationMinutes} min:\n${r.slots
      .map((s) => `${fmt(s.start, true)}–${fmt(s.end, false)} (${s.minutes} min) start=${s.start}`)
      .join('\n')}`;
  },
});

/* ─────────────── automations ─────────────── */

const automationsList = defineTool({
  name: 'automations_list',
  group: 'productivity',
  keywords: ['schedules', 'cron', 'recurring', 'scheduled prompts', 'jobs'],
  description: 'List scheduled automations (recurring prompts Monarch runs on its own) with schedule, next run and last status.',
  risk: 'safe',
  tag: 'AUTO',
  schema: z.object({}),
  run: () => {
    const list = listAutomations();
    return list.length ? list.map(fmtAutomation).join('\n') : 'No automations configured.';
  },
});

const automationCreate = defineTool({
  name: 'automation_create',
  group: 'productivity',
  keywords: ['schedule', 'cron', 'recurring', 'every day', 'every morning', 'routine', 'job'],
  description:
    'Create a recurring automation: Monarch will run `prompt` in its own session on `schedule` and (optionally) post the result as a notification. ' +
    'Schedule formats: 5-field cron in local time ("0 8 * * 1-5" = weekdays 08:00), or shorthand "every 30m", "every 2h", "every 1d", "daily 08:00", "weekdays 07:30", "hourly". ' +
    'Write the prompt as a self-contained instruction (it runs without this conversation\'s context).',
  risk: 'sensitive',
  tag: 'AUTO',
  schema: z.object({
    name: z.string().min(1).describe('Short name, e.g. "Morning inbox digest".'),
    schedule: z.string().describe('Cron or shorthand schedule (see description).'),
    prompt: z.string().min(1).describe('Self-contained instruction to run each time.'),
    notify: z.boolean().optional().describe('Post the result to notifications (default true).'),
    enabled: z.boolean().optional().describe('Start enabled (default true).'),
  }),
  summarize: (i) => `Create automation "${i.name}" (${i.schedule})`,
  run: (i) => {
    parseSchedule(i.schedule);
    return `Created: ${fmtAutomation(createAutomation(i, { announce: true }))}`;
  },
});

const automationDelete = defineTool({
  name: 'automation_delete',
  group: 'productivity',
  keywords: ['remove schedule', 'cron', 'recurring', 'job'],
  description: 'Delete an automation by id (ids from automations_list).',
  risk: 'dangerous',
  tag: 'AUTO',
  schema: z.object({ id: z.string().describe('Automation id.') }),
  summarize: (i) => `Delete automation ${i.id}`,
  run: ({ id }) => `Deleted automation "${deleteAutomation(id).name}".`,
});

export const tools: ToolDef[] = [
  tasksList,
  taskAdd,
  taskUpdate,
  taskComplete,
  taskDelete,
  calendarList,
  calendarAdd,
  calendarUpdate,
  calendarRespond,
  calendarFreeSlots,
  calendarDelete,
  automationsList,
  automationCreate,
  automationDelete,
];
