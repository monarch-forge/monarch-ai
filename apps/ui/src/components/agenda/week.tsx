/** Week calendar (06–24 grid, all-day row, now-line), event popover and new-event modal. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { CalendarEvent, GoogleAccount } from '@monarch/shared';
import { ChevronLeft, ChevronRight, MapPin, Plus, Trash, Video, X, CalendarDays } from 'lucide-preact';
import { api, openExternal, qs } from '../../lib/api.ts';
import { toast, useResource } from '../../lib/store.ts';
import { Btn, EmptyState, Glyph, useNow } from '../ui.tsx';
import { AccountMark, accountColor, askMonarch, Button, LoadError, Modal, sameDay, toDateInput, useConfirm } from '../mail/kit.tsx';

const H0 = 6;
const H1 = 24;
const ROW = 44; // px per hour
const DAY_MS = 86400000;

export function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - dow);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
const pad = (n: number) => String(n).padStart(2, '0');
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

interface Placed {
  ev: CalendarEvent;
  top: number;
  height: number;
  col: number;
  cols: number;
  start: Date;
  end: Date;
}

function evStart(e: CalendarEvent): Date {
  return new Date(e.start);
}
function evEnd(e: CalendarEvent): Date {
  const s = evStart(e);
  const en = e.end ? new Date(e.end) : null;
  if (en && !isNaN(en.getTime()) && en > s) return en;
  return new Date(s.getTime() + (e.allDay ? DAY_MS : 30 * 60000));
}
function isAllDay(e: CalendarEvent): boolean {
  return !!e.allDay || evEnd(e).getTime() - evStart(e).getTime() >= DAY_MS - 60000;
}

/** lay out timed events for one day: clip to the visible window, then split overlapping clusters into columns */
function layoutDay(day: Date, events: CalendarEvent[]): Placed[] {
  const d0 = new Date(day.getFullYear(), day.getMonth(), day.getDate(), H0);
  const d1 = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const items = events
    .filter((e) => !isAllDay(e))
    .map((ev) => ({ ev, s: evStart(ev), e: evEnd(ev) }))
    .filter((x) => x.e > dayStart && x.s < d1)
    .map((x) => {
      // events entirely before 06:00 are pinned to the top edge
      let s = x.s < d0 ? d0 : x.s;
      let e = x.e > d1 ? d1 : x.e;
      if (e <= d0) {
        s = d0;
        e = new Date(d0.getTime() + 20 * 60000);
      }
      return { ...x, cs: s, ce: e };
    })
    .sort((a, b) => a.cs.getTime() - b.cs.getTime() || b.ce.getTime() - a.ce.getTime());

  const out: Placed[] = [];
  let cluster: { item: (typeof items)[number]; col: number }[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) {
      const top = ((c.item.cs.getTime() - d0.getTime()) / 3600000) * ROW;
      const height = Math.max(18, ((c.item.ce.getTime() - c.item.cs.getTime()) / 3600000) * ROW - 2);
      out.push({ ev: c.item.ev, top, height, col: c.col, cols, start: c.item.s, end: c.item.e });
    }
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.cs.getTime() >= clusterEnd) flush();
    const colEnds: number[] = [];
    for (const c of cluster) colEnds[c.col] = Math.max(colEnds[c.col] ?? 0, c.item.ce.getTime());
    let col = 0;
    while (colEnds[col] !== undefined && colEnds[col] > it.cs.getTime()) col++;
    cluster.push({ item: it, col });
    clusterEnd = Math.max(clusterEnd, it.ce.getTime());
  }
  if (cluster.length) flush();
  return out;
}

export function WeekCalendar(props: { accounts: GoogleAccount[] }) {
  const now = useNow(60000);
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const from = anchor.toISOString();
  const to = addDays(anchor, 7).toISOString();
  const res = useResource<CalendarEvent[]>(`/events${qs({ from, to })}`, ['events']);
  const events = useMemo(() => (Array.isArray(res.data) ? res.data.filter((e) => e && e.id && e.start && !isNaN(new Date(e.start).getTime())) : []), [res.data]);
  const [pop, setPop] = useState<{ ev: CalendarEvent; x: number; y: number } | null>(null);
  const [create, setCreate] = useState<{ start: Date } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // initial scroll: an hour before now (or 08:00)
  useLayoutEffect(() => {
    const h = Math.max(H0, Math.min(H1 - 6, new Date().getHours() - 1));
    if (scroller.current) scroller.current.scrollTop = (h - H0) * ROW;
  }, []);

  const allDayByDay = days.map((d) => {
    const ds = d.getTime();
    const de = ds + DAY_MS;
    return events.filter((e) => isAllDay(e) && evStart(e).getTime() < de && evEnd(e).getTime() > ds);
  });
  const timedByDay = days.map((d) => layoutDay(d, events));
  const thisWeek = sameDay(anchor, startOfWeek(now));
  const nowTop = ((now.getHours() + now.getMinutes() / 60 - H0) / 1) * ROW;
  const rangeLabel = `${days[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} — ${days[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const onGridClick = (day: Date, e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-ev]')) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const hours = (e.clientY - rect.top) / ROW + H0;
    const half = Math.floor(hours * 2) / 2;
    const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(half), (half % 1) * 60);
    setCreate({ start: s });
  };

  const openPop = (ev: CalendarEvent, e: MouseEvent) => {
    e.stopPropagation();
    setPop({ ev, x: e.clientX, y: e.clientY });
  };

  const todayIdx = days.findIndex((d) => sameDay(d, now));
  const todayList = useMemo(
    () =>
      todayIdx < 0
        ? []
        : [...allDayByDay[todayIdx].map((ev) => ({ ev, s: evStart(ev), e: evEnd(ev), all: true })), ...timedByDay[todayIdx].map((p) => ({ ev: p.ev, s: p.start, e: p.end, all: false }))].sort(
            (a, b) => Number(b.all) - Number(a.all) || a.s.getTime() - b.s.getTime(),
          ),
    [events, todayIdx],
  );
  const chip = (color: string) => ({ background: `color-mix(in srgb, ${color} 16%, transparent)`, color: `color-mix(in srgb, ${color} 55%, #f4f4f6)` });

  return (
    <section class="flex-1 min-w-0 flex flex-col min-h-0 bg-base-200 rounded-[var(--radius-card)] overflow-hidden">
      <header class="flex items-center gap-2 px-4 sm:px-5 pt-4 pb-3">
        <div class="min-w-0">
          <h1 class="ds-dot uppercase text-[24px] leading-none text-fg truncate">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
          <div class="text-[12.5px] text-fg-3 truncate">{thisWeek ? 'This week' : rangeLabel}</div>
        </div>
        {res.loading && <Glyph value={3} of={3} live class="ml-1" title="Syncing" />}
        <div class="ml-auto flex items-center gap-0.5">
          <Btn pill variant="ghost" size="xs" class="btn-square" title="Previous week ([)" aria-label="Previous week" onClick={() => setAnchor(addDays(anchor, -7))}>
            <ChevronLeft size={15} />
          </Btn>
          <Btn pill variant="ghost" size="xs" title="This week (.)" onClick={() => setAnchor(startOfWeek(new Date()))}>
            Today
          </Btn>
          <Btn pill variant="ghost" size="xs" class="btn-square" title="Next week (])" aria-label="Next week" onClick={() => setAnchor(addDays(anchor, 7))}>
            <ChevronRight size={15} />
          </Btn>
        </div>
        <Btn pill size="sm" variant="primary" onClick={() => setCreate({ start: defaultStart(now) })} title="New event">
          <Plus size={13} /> <span class="hidden sm:inline">Event</span>
        </Btn>
      </header>
      <KeyNav onPrev={() => setAnchor(addDays(anchor, -7))} onNext={() => setAnchor(addDays(anchor, 7))} onToday={() => setAnchor(startOfWeek(new Date()))} />
      {res.error && !res.data && <LoadError error={res.error} onRetry={res.reload} class="py-3!" />}

      {/* today, first: the whole view on narrow screens */}
      <div class="md:hidden flex-1 min-h-0 overflow-y-auto px-3 pb-4">
        {!thisWeek ? (
          <div class="px-2 py-6 text-[13px] text-fg-3">
            Viewing {rangeLabel}.{' '}
            <button class="text-fg-2 underline underline-offset-2" onClick={() => setAnchor(startOfWeek(new Date()))}>
              Back to today
            </button>
          </div>
        ) : !todayList.length ? (
          <EmptyState
            icon={<CalendarDays size={18} strokeWidth={1.5} />}
            title="A clear day"
            hint="Nothing on the calendar today."
            actions={
              <>
                <Btn pill variant="primary" onClick={() => setCreate({ start: defaultStart(now) })}>
                  <Plus size={12} /> Add event
                </Btn>
                <Btn pill onClick={() => askMonarch('Plan my day: look at my calendar, open tasks and unread mail, and suggest what to do and when.')}>Plan my day</Btn>
              </>
            }
          />
        ) : (
          todayList.map((x) => {
            const color = x.ev.source === 'google' ? accountColor(x.ev.accountId) : '#9E9EA4';
            return (
              <button key={x.ev.id} class={`w-full text-left flex gap-3 px-2 py-2.5 rounded-[var(--radius-control)] hover:bg-white/[0.03] ${x.e < now ? 'opacity-55' : ''}`} onClick={(e) => openPop(x.ev, e as unknown as MouseEvent)}>
                <span class="w-12 shrink-0 font-mono text-[11.5px] text-fg-3 pt-0.5">{x.all ? 'all day' : hm(x.s)}</span>
                <span class="w-[3px] self-stretch rounded-full shrink-0" style={{ background: color }} />
                <span class="min-w-0">
                  <span class="block text-[14px] text-fg truncate">{x.ev.title || '(untitled)'}</span>
                  {x.ev.location && <span class="block text-[12px] text-fg-3 truncate">{x.ev.location}</span>}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* week grid */}
      <div class="hidden md:flex flex-col flex-1 min-h-0">
        <div class="grid grid-cols-[52px_repeat(7,minmax(0,1fr))] px-2">
          <div />
          {days.map((d) => {
            const today = sameDay(d, now);
            return (
              <div key={d.toISOString()} class="px-1.5 pb-2 flex items-baseline gap-1.5">
                <span class={`text-[12px] ${today ? 'text-fg font-medium' : 'text-fg-3'}`}>{d.toLocaleDateString([], { weekday: 'short' })}</span>
                <span
                  class={`text-[13px] tabular-nums ${today ? 'text-fg font-semibold bg-red/90 rounded-full w-6 h-6 grid place-items-center -my-1' : 'text-fg-2'}`}
                >
                  {d.getDate()}
                </span>
              </div>
            );
          })}
        </div>
        {/* all-day row (only when something is all-day) */}
        {allDayByDay.some((l) => l.length) && (
          <div class="grid grid-cols-[52px_repeat(7,minmax(0,1fr))] px-2 pb-1.5">
            <div class="text-[10.5px] text-fg-3 pr-2 pt-1 text-right">all day</div>
            {allDayByDay.map((list, i) => (
              <div key={i} class="px-0.5 flex flex-col gap-0.5 min-w-0">
                {list.map((ev) => (
                  <button
                    key={ev.id}
                    data-ev
                    class="text-left text-[11.5px] truncate px-2 py-0.5 rounded-[var(--radius-control)] hover:brightness-125 transition"
                    style={chip(ev.source === 'google' ? accountColor(ev.accountId) : '#9E9EA4')}
                    onClick={(e) => openPop(ev, e)}
                    title={ev.title}
                  >
                    {ev.title || '(untitled)'}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {/* timed grid */}
        <div ref={scroller} class="flex-1 min-h-0 overflow-y-auto relative px-2 pb-2">
          <div class="grid grid-cols-[52px_repeat(7,minmax(0,1fr))] relative" style={{ height: `${(H1 - H0) * ROW}px` }}>
            <div class="relative">
              {Array.from({ length: H1 - H0 }, (_, i) =>
                i === 0 || i % 2 ? null : (
                  <div key={i} class="absolute right-2.5 font-mono text-[10.5px] text-fg-3/80 tabular-nums" style={{ top: `${i * ROW - 7}px` }}>
                    {pad(H0 + i)}:00
                  </div>
                ),
              )}
            </div>
            {days.map((d, di) => {
              const today = sameDay(d, now);
              return (
                <div
                  key={d.toISOString()}
                  class={`relative cursor-cell rounded-[var(--radius-control)] ${today ? 'bg-white/[0.025]' : ''}`}
                  onClick={(e) => onGridClick(d, e as unknown as MouseEvent)}
                  style={{
                    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${2 * ROW - 1}px, rgb(255 255 255 / 0.035) ${2 * ROW - 1}px, rgb(255 255 255 / 0.035) ${2 * ROW}px)`,
                  }}
                >
                  {timedByDay[di].map((p) => {
                    const past = p.end.getTime() < now.getTime();
                    const color = p.ev.source === 'google' ? accountColor(p.ev.accountId) : '#9E9EA4';
                    const small = p.height < 34;
                    return (
                      <button
                        key={p.ev.id + di}
                        data-ev
                        class={`absolute text-left overflow-hidden rounded-[var(--radius-control)] px-2 py-1 hover:brightness-125 transition ${past ? 'opacity-50' : ''}`}
                        style={{
                          top: `${p.top + 1}px`,
                          height: `${p.height}px`,
                          left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                          width: `calc(${100 / p.cols}% - 4px)`,
                          ...chip(color),
                        }}
                        onClick={(e) => openPop(p.ev, e as unknown as MouseEvent)}
                        title={`${p.ev.title} · ${hm(p.start)}–${hm(p.end)}`}
                      >
                        <div class={`text-[12px] leading-tight font-medium truncate ${small ? 'inline' : ''}`}>{p.ev.title || '(untitled)'}</div>
                        {!small && (
                          <div class="text-[10.5px] opacity-75 truncate mt-0.5">
                            {hm(p.start)}–{hm(p.end)}
                            {p.ev.location ? ` · ${p.ev.location}` : ''}
                          </div>
                        )}
                        {small && <span class="text-[10.5px] opacity-75 ml-1.5">{hm(p.start)}</span>}
                      </button>
                    );
                  })}
                  {today && thisWeek && nowTop >= 0 && nowTop <= (H1 - H0) * ROW && (
                    <div class="absolute left-0 right-0 pointer-events-none z-10" style={{ top: `${nowTop}px` }}>
                      <div class="h-px bg-red/80" />
                      <div class="absolute -left-[3px] -top-[3px] w-[7px] h-[7px] rounded-full bg-red" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!events.length && res.data !== undefined && (
            <div class="absolute top-4 left-1/2 -translate-x-1/2 text-[12.5px] text-fg-3 bg-subtle rounded-full px-3 py-1 pointer-events-none">
              A quiet week. Click anywhere on the grid to add something.
            </div>
          )}
        </div>
      </div>
      {pop && <EventPopover ev={pop.ev} x={pop.x} y={pop.y} accounts={props.accounts} onClose={() => setPop(null)} onDeleted={() => void res.reload()} />}
      <NewEventModal open={!!create} start={create?.start ?? null} accounts={props.accounts} onClose={() => setCreate(null)} onCreated={() => void res.reload()} />
    </section>
  );
}

function defaultStart(now: Date): Date {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function KeyNav(props: { onPrev: () => void; onNext: () => void; onToday: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '') || document.querySelector('[aria-modal="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '[') props.onPrev();
      else if (e.key === ']') props.onNext();
      else if (e.key === '.') props.onToday();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return null;
}

/* ───────────────────────── popover ───────────────────────── */

function EventPopover(props: { ev: CalendarEvent; x: number; y: number; accounts: GoogleAccount[]; onClose: () => void; onDeleted: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dialog, confirm] = useConfirm();
  const [pos, setPos] = useState({ left: props.x + 8, top: props.y + 8 });
  const ev = props.ev;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(props.x + 10, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(props.y + 10, window.innerHeight - r.height - 8)),
    });
  }, [props.x, props.y, ev.id]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[aria-modal="true"]') && props.onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const s = evStart(ev);
  const e = evEnd(ev);
  const acct = props.accounts.find((a) => a.id === ev.accountId);
  const del = async () => {
    if (!(await confirm({ title: 'Delete event', body: `Delete “${ev.title}”${ev.source === 'google' ? ` from Google Calendar (${acct?.email ?? ev.accountId})` : ''}?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/events/${encodeURIComponent(ev.id)}`);
      toast('Event deleted', 'success');
      props.onDeleted();
      props.onClose();
    } catch (err: any) {
      toast(`Delete failed: ${err?.message ?? err}`, 'error');
    }
  };
  const when = ev.allDay
    ? `${s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · all day`
    : `${s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${hm(s)}–${hm(e)}${sameDay(s, e) ? '' : ` (${e.toLocaleDateString([], { month: 'short', day: 'numeric' })})`}`;

  return (
    <>
      <div ref={ref} tabIndex={-1} role="dialog" aria-label={ev.title} class="fixed z-30 w-80 bg-base-200 rounded-[var(--radius-card)] shadow-[0_12px_32px_rgb(0_0_0/0.45)] outline-none" style={{ left: `${pos.left}px`, top: `${pos.top}px` }}>
        <header class="flex items-center gap-2.5 px-4 pt-4">
          {ev.source === 'google' ? <AccountMark id={ev.accountId} size={8} /> : <span class="w-2 h-2 rounded-full bg-fg-2 shrink-0" />}
          <h2 class="text-[14.5px] font-semibold text-fg truncate">{ev.title || '(untitled)'}</h2>
          <Btn pill variant="ghost" size="xs" class="ml-auto -mr-1 btn-square" onClick={props.onClose} aria-label="Close">
            <X size={14} />
          </Btn>
        </header>
        <div class="px-4 pt-1.5 pb-4 flex flex-col gap-2 text-[13px]">
          <div class="text-fg-2">{when}</div>
          <div class="text-[12px] text-fg-3">{ev.source === 'google' ? `Google · ${acct?.email ?? ev.accountId ?? ''}` : 'Local calendar'}</div>
          {ev.location && (
            <div class="flex items-start gap-1.5 text-fg-2">
              <MapPin size={12} class="mt-0.5 shrink-0 text-fg-3" /> <span class="break-words">{ev.location}</span>
            </div>
          )}
          {ev.notes && <div class="text-fg-2 whitespace-pre-wrap break-words max-h-40 overflow-y-auto border-l-2 border-subtle pl-2.5">{ev.notes}</div>}
          <div class="flex items-center gap-2 mt-1">
            {ev.link && (
              <Btn pill size="xs" variant="primary" onClick={() => void openExternal(ev.link!)}>
                <Video size={12} /> Join
              </Btn>
            )}
            <Btn pill size="xs" variant="ghost" class="ml-auto hover:text-red!" onClick={del}>
              <Trash size={12} /> Delete
            </Btn>
          </div>
        </div>
      </div>
      {dialog}
    </>
  );
}

/* ───────────────────────── new event ───────────────────────── */

function NewEventModal(props: { open: boolean; start: Date | null; accounts: GoogleAccount[]; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ title: '', date: '', from: '', to: '', allDay: false, location: '', notes: '', cal: 'local' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!props.open || !props.start) return;
    const s = props.start;
    const e = new Date(s.getTime() + 60 * 60000);
    setF({ title: '', date: toDateInput(s), from: hm(s), to: sameDay(s, e) ? hm(e) : '23:59', allDay: false, location: '', notes: '', cal: 'local' });
  }, [props.open, props.start?.getTime()]);

  const set = (k: keyof typeof f) => (e: Event) => {
    const t = e.target as HTMLInputElement;
    setF({ ...f, [k]: t.type === 'checkbox' ? t.checked : t.value });
  };
  const start = f.date ? new Date(`${f.date}T${f.allDay ? '00:00' : f.from || '00:00'}`) : null;
  let end = f.date ? new Date(`${f.date}T${f.allDay ? '00:00' : f.to || f.from || '00:00'}`) : null;
  if (f.allDay && end) end = addDays(end, 1);
  const invalid = !f.title.trim() || !start || isNaN(start.getTime()) || !end || isNaN(end.getTime()) || end <= start;

  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true);
    try {
      const google = f.cal !== 'local';
      await api.post<CalendarEvent>('/events', {
        source: google ? 'google' : 'local',
        accountId: google ? f.cal : undefined,
        title: f.title.trim(),
        start: start!.toISOString(),
        end: end!.toISOString(),
        allDay: f.allDay,
        location: f.location.trim() || undefined,
        notes: f.notes.trim() || undefined,
      });
      toast('Event created', 'success');
      props.onCreated();
      props.onClose();
    } catch (e: any) {
      toast(`Create failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const lab = 'text-[12.5px] text-fg-2';
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="New event"
      footer={
        <>
          <Btn pill variant="ghost" onClick={props.onClose}>
            Cancel
          </Btn>
          <Button variant="primary" loading={busy} disabled={invalid} onClick={submit}>
            <CalendarDays size={12} /> Create
          </Button>
        </>
      }
    >
      <form
        class="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label class="col-span-2 flex flex-col gap-1.5">
          <span class={lab}>Title</span>
          <input class="hud-input" value={f.title} onInput={set('title')} placeholder="Board review" data-autofocus />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class={lab}>Date</span>
          <input type="date" class="hud-input font-mono text-[13px]!" value={f.date} onInput={set('date')} />
        </label>
        <label class="flex items-end gap-2 pb-2.5">
          <input type="checkbox" class="checkbox checkbox-xs rounded" checked={f.allDay} onChange={set('allDay')} />
          <span class="text-[13px] text-fg-2">All day</span>
        </label>
        {!f.allDay && (
          <>
            <label class="flex flex-col gap-1.5">
              <span class={lab}>Start</span>
              <input type="time" class="hud-input font-mono text-[13px]!" value={f.from} onInput={set('from')} />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class={lab}>End</span>
              <input type="time" class="hud-input font-mono text-[13px]!" value={f.to} onInput={set('to')} />
            </label>
          </>
        )}
        <label class="col-span-2 flex flex-col gap-1.5">
          <span class={lab}>Location / link</span>
          <input class="hud-input" value={f.location} onInput={set('location')} placeholder="HQ · or a meeting URL" />
        </label>
        <label class="col-span-2 flex flex-col gap-1.5">
          <span class={lab}>Notes</span>
          <textarea class="hud-input min-h-20 resize-y" value={f.notes} onInput={set('notes')} />
        </label>
        <label class="col-span-2 flex flex-col gap-1.5">
          <span class={lab}>Calendar</span>
          <select class="select select-sm w-full bg-white/[0.04] border-line text-[13px] rounded-[var(--radius-control)]" value={f.cal} onChange={set('cal')}>
            <option value="local">Local (Monarch)</option>
            {props.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                Google · {a.email}
              </option>
            ))}
          </select>
        </label>
        {!invalid ? null : f.title.trim() && <div class="col-span-2 text-[12px] text-warning">End must be after start.</div>}
        <button type="submit" class="hidden" />
      </form>
    </Modal>
  );
}
