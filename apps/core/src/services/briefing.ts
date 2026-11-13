/** Dashboard briefing: fast, rule-based (no LLM). */
import type { Briefing, CalendarEvent } from '@monarch/shared';
import { notifications } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { mailUnreadCount } from '../integrations/google/index.ts';
import { listTasks } from './tasks.ts';
import { listEvents } from './events.ts';
import { getMetrics, lastMetrics } from './metrics.ts';
import { addDays, startOfDay } from './dates.ts';

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref())]);
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

export function greeting(now = new Date()): string {
  const h = now.getHours();
  const part = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 18 ? 'afternoon' : 'evening';
  const honorific = getSettings().user.honorific?.trim();
  return `Good ${part}${honorific ? `, ${honorific}` : ''}.`;
}

export async function buildBriefing(): Promise<Briefing> {
  const now = new Date();
  const flags: Briefing['flags'] = [];

  const open = listTasks({ done: false });
  const endOfToday = addDays(startOfDay(now), 1).getTime();
  const overdue = open.filter((t) => t.due && Date.parse(t.due) < now.getTime());
  const dueToday = open.filter((t) => t.due && Date.parse(t.due) >= now.getTime() && Date.parse(t.due) < endOfToday);
  if (overdue.length)
    flags.push({
      tag: 'TSK',
      level: 'warn',
      href: '#/agenda',
      text: overdue.length === 1 ? `Overdue: ${overdue[0].title}` : `${overdue.length} tasks overdue`,
    });
  if (dueToday.length)
    flags.push({
      tag: 'TSK',
      level: 'info',
      href: '#/agenda',
      text: dueToday.length === 1 ? `Due today: ${dueToday[0].title}` : `${dueToday.length} tasks due today`,
    });

  const [events, unreadMail, metrics] = await Promise.all([
    withTimeout(listEvents(now, addDays(now, 7), { googleTimeoutMs: 2500 }), 3000, [] as CalendarEvent[]),
    withTimeout(mailUnreadCount(), 2500, 0),
    lastMetrics() ? Promise.resolve(lastMetrics()) : withTimeout(getMetrics(), 2500, null),
  ]);

  const nextEvent = events.find((e) => !e.allDay && Date.parse(e.start) >= now.getTime() - 5 * 60e3) ?? null;
  if (nextEvent && Date.parse(nextEvent.start) - now.getTime() <= 2 * 3600e3) {
    const mins = Math.round((Date.parse(nextEvent.start) - now.getTime()) / 60e3);
    flags.push({
      tag: 'CAL',
      level: 'info',
      href: '#/agenda',
      text: mins <= 0 ? `Now: ${nextEvent.title}` : `${nextEvent.title} at ${hhmm(nextEvent.start)} (in ${mins} min)`,
    });
  }

  if (unreadMail > 0)
    flags.push({ tag: 'MAIL', level: 'info', href: '#/mail', text: `${unreadMail} unread ${unreadMail === 1 ? 'thread' : 'threads'}` });

  const unreadNotes = notifications.get().filter((n) => !n.read).length;
  if (unreadNotes > 0)
    flags.push({ tag: 'SYS', level: 'info', text: `${unreadNotes} unread ${unreadNotes === 1 ? 'notification' : 'notifications'}` });

  if (metrics) {
    if (metrics.cpu.load > 90) flags.push({ tag: 'SYS', level: 'warn', href: '#/systems', text: `CPU load at ${Math.round(metrics.cpu.load)}%` });
    if (metrics.mem.percent > 90)
      flags.push({ tag: 'SYS', level: 'warn', href: '#/systems', text: `Memory usage at ${Math.round(metrics.mem.percent)}%` });
    for (const d of metrics.disk)
      if (d.percent > 90) flags.push({ tag: 'SYS', level: 'warn', href: '#/systems', text: `Disk ${d.mount} at ${Math.round(d.percent)}%` });
  }

  const n = flags.length;
  const count = n < WORDS.length ? WORDS[n] : String(n);
  const headline =
    n === 0
      ? 'All systems nominal. No items require your attention.'
      : `All systems nominal. ${count} ${n === 1 ? 'item' : 'items'} flagged for your attention.`;
  return {
    greeting: greeting(now),
    headline: flags.some((f) => f.tag === 'SYS' && f.level !== 'info')
      ? headline.replace('All systems nominal.', 'System load elevated.')
      : headline,
    flags,
    nextEvent,
    unreadMail,
    openTasks: open.length,
  };
}
