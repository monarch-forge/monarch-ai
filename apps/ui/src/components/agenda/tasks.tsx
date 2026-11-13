/** Tasks panel: quick-add, grouped list (Overdue / Today / Upcoming / No date / Done), inline editor. */
import { useMemo, useRef, useState } from 'preact/hooks';
import type { Task } from '@monarch/shared';
import { Bell, ChevronDown, ChevronRight, Plus, Trash } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { toast, useResource } from '../../lib/store.ts';
import { Btn, Panel, Tag } from '../ui.tsx';
import { fromLocalInput, LoadError, Loading, relTime, sameDay, StateBlock, toLocalInput, useConfirm } from '../mail/kit.tsx';

type Group = 'overdue' | 'today' | 'upcoming' | 'nodate' | 'done';
const GROUP_NAMES: Record<Group, string> = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming', nodate: 'No date', done: 'Done' };

function groupOf(t: Task, now: Date): Group {
  if (t.done) return 'done';
  if (!t.due) return 'nodate';
  const d = new Date(t.due);
  if (isNaN(d.getTime())) return 'nodate';
  if (d < now) return 'overdue';
  if (sameDay(d, now)) return 'today';
  return 'upcoming';
}

function dueLabel(iso: string | null | undefined, now: Date): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay(d, now)) return t;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameDay(d, tomorrow)) return `Tomorrow ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${t}`;
}

/** "Call Pepper #home #urgent" -> title + tags */
function parseQuick(s: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  const title = s
    .replace(/(^|\s)#([\w-]+)/g, (_, pre: string, tag: string) => {
      tags.push(tag);
      return pre;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { title, tags };
}

export function TasksPanel(props: { class?: string }) {
  const res = useResource<Task[]>('/tasks', ['tasks']);
  const tasks = useMemo(() => (Array.isArray(res.data) ? res.data.filter((t) => t && typeof t.id === 'string') : []), [res.data]);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [prio, setPrio] = useState<Task['priority']>('normal');
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, confirm] = useConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  const now = new Date();

  const groups = useMemo(() => {
    const g: Record<Group, Task[]> = { overdue: [], today: [], upcoming: [], nodate: [], done: [] };
    for (const t of tasks) g[groupOf(t, now)].push(t);
    const byDue = (a: Task, b: Task) => new Date(a.due ?? 0).getTime() - new Date(b.due ?? 0).getTime();
    const pr = { high: 0, normal: 1, low: 2 } as const;
    g.overdue.sort(byDue);
    g.today.sort(byDue);
    g.upcoming.sort(byDue);
    g.nodate.sort((a, b) => (pr[a.priority] ?? 1) - (pr[b.priority] ?? 1) || String(b.createdAt).localeCompare(String(a.createdAt)));
    g.done.sort((a, b) => String(b.completedAt ?? b.createdAt).localeCompare(String(a.completedAt ?? a.createdAt)));
    return g;
  }, [tasks, Math.floor(now.getTime() / 60000)]);

  const patch = async (t: Task, p: Partial<Task>) => {
    const prev = res.data;
    if (prev) res.setData(prev.map((x) => (x.id === t.id ? { ...x, ...p } : x)));
    try {
      await api.patch<Task>(`/tasks/${encodeURIComponent(t.id)}`, p);
    } catch (e: any) {
      if (prev) res.setData(prev);
      toast(`Update failed: ${e?.message ?? e}`, 'error');
    }
  };

  const add = async () => {
    const { title: tt, tags } = parseQuick(title);
    if (!tt || adding) return;
    setAdding(true);
    try {
      const t = await api.post<Task>('/tasks', { title: tt, tags, priority: prio, due: fromLocalInput(due), done: false });
      if (t && typeof t === 'object' && res.data) res.setData([...res.data, t]);
      setTitle('');
      setDue('');
      setPrio('normal');
      void res.reload();
    } catch (e: any) {
      toast(`Add failed: ${e?.message ?? e}`, 'error');
    } finally {
      setAdding(false);
      inputRef.current?.focus();
    }
  };

  const remove = async (t: Task) => {
    if (!(await confirm({ title: 'Delete task', body: `Delete “${t.title}”?`, confirmLabel: 'Delete', danger: true }))) return;
    const prev = res.data;
    if (prev) res.setData(prev.filter((x) => x.id !== t.id));
    try {
      await api.del(`/tasks/${encodeURIComponent(t.id)}`);
    } catch (e: any) {
      if (prev) res.setData(prev);
      toast(`Delete failed: ${e?.message ?? e}`, 'error');
    }
  };

  const open = tasks.filter((t) => !t.done).length;

  return (
    <Panel
      code="TSK.01"
      title="Tasks"
      class={props.class}
      noPad
      bodyClass="flex flex-col min-h-0"
      right={
        <>
          {groups.overdue.length > 0 && <Tag tone="red">{groups.overdue.length} overdue</Tag>}
          <Tag>{open} open</Tag>
        </>
      }
    >
      <form
        class="p-2.5 border-b border-line flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div class="flex gap-2">
          <input
            ref={inputRef}
            class="hud-input py-1.5! text-[13px]! flex-1"
            placeholder="Add a task…  #tag"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            aria-label="New task title"
          />
          <Btn size="xs" variant={title.trim() ? 'primary' : 'outline'} type="submit" loading={adding} class="h-auto!" aria-label="Add task">
            <Plus size={12} />
          </Btn>
        </div>
        {title.trim() && (
          <div class="flex gap-2 items-center">
            <input type="datetime-local" class="hud-input py-1! text-[11px]! font-mono flex-1" value={due} onInput={(e) => setDue((e.target as HTMLInputElement).value)} aria-label="Due" title="Due (optional)" />
            <PrioritySelect value={prio} onChange={setPrio} />
          </div>
        )}
      </form>
      <div class="flex-1 min-h-0 overflow-y-auto">
        {res.error && !res.data ? (
          <LoadError error={res.error} onRetry={res.reload} />
        ) : res.data === undefined ? (
          <Loading label="Loading tasks" />
        ) : !tasks.length ? (
          <StateBlock title="No tasks">Add one above, or tell Monarch “remind me to…” in chat.</StateBlock>
        ) : (
          (['overdue', 'today', 'upcoming', 'nodate'] as Group[])
            .filter((g) => groups[g].length)
            .map((g) => (
              <section key={g}>
                <div class={`hud-label px-3 pt-2.5 pb-1 flex ${g === 'overdue' ? 'text-red!' : ''}`}>
                  {GROUP_NAMES[g]}
                  <span class="ml-auto">{groups[g].length}</span>
                </div>
                {groups[g].map((t) => (
                  <TaskRow key={t.id} t={t} now={now} open={openId === t.id} onToggleOpen={() => setOpenId(openId === t.id ? null : t.id)} onPatch={(p) => patch(t, p)} onDelete={() => remove(t)} />
                ))}
              </section>
            ))
        )}
        {groups.done.length > 0 && (
          <section class="border-t border-line mt-1">
            <button class="hud-label px-3 py-2 flex items-center gap-1.5 w-full hover:text-fg-2" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>
              {showDone ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Done
              <span class="ml-auto">{groups.done.length}</span>
            </button>
            {showDone &&
              groups.done
                .slice(0, 30)
                .map((t) => (
                  <TaskRow key={t.id} t={t} now={now} open={openId === t.id} onToggleOpen={() => setOpenId(openId === t.id ? null : t.id)} onPatch={(p) => patch(t, p)} onDelete={() => remove(t)} />
                ))}
          </section>
        )}
      </div>
      {dialog}
    </Panel>
  );
}

function PrioritySelect(props: { value: Task['priority']; onChange: (p: Task['priority']) => void }) {
  return (
    <select
      class="select select-xs bg-[#121213] border-line rounded-[2px] font-mono text-[11px] w-24"
      value={props.value}
      onChange={(e) => props.onChange((e.target as HTMLSelectElement).value as Task['priority'])}
      aria-label="Priority"
    >
      <option value="low">low</option>
      <option value="normal">normal</option>
      <option value="high">high</option>
    </select>
  );
}

function TaskRow(props: { t: Task; now: Date; open: boolean; onToggleOpen: () => void; onPatch: (p: Partial<Task>) => void; onDelete: () => void }) {
  const t = props.t;
  const overdue = !t.done && !!t.due && new Date(t.due) < props.now;
  return (
    <div class={`border-l-2 ${props.open ? 'border-l-fg-3 bg-white/[0.02]' : 'border-l-transparent'}`}>
      <div class="group flex items-start gap-2.5 px-3 py-1.5 hover:bg-white/[0.02]">
        <button
          class={`mt-[3px] w-3.5 h-3.5 shrink-0 border grid place-items-center ${t.done ? 'bg-fg-2 border-fg-2' : 'border-fg-3 hover:border-fg'}`}
          role="checkbox"
          aria-checked={t.done}
          aria-label={t.done ? 'Mark not done' : 'Mark done'}
          onClick={() => props.onPatch({ done: !t.done, completedAt: !t.done ? new Date().toISOString() : null })}
        >
          {t.done && (
            <svg viewBox="0 0 10 10" class="w-2.5 h-2.5">
              <path d="M2 5.2 4.2 7.3 8 2.8" fill="none" stroke="#121213" stroke-width="1.6" />
            </svg>
          )}
        </button>
        <button class="min-w-0 flex-1 text-left" onClick={props.onToggleOpen} aria-expanded={props.open}>
          <div class={`text-[13px] leading-snug ${t.done ? 'text-fg-3 line-through' : 'text-fg'}`}>{t.title}</div>
          {(t.due || t.remindAt || t.tags?.length > 0) && (
            <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 font-mono text-[10px] text-fg-3">
              {t.due && <span class={overdue ? 'text-red' : ''}>{dueLabel(t.due, props.now)}</span>}
              {t.remindAt && !t.done && (
                <span class="inline-flex items-center gap-0.5" title={`Reminder ${new Date(t.remindAt).toLocaleString()}`}>
                  <Bell size={9} /> {relTime(t.remindAt)}
                </span>
              )}
              {(t.tags ?? []).map((g) => (
                <span key={g}>#{g}</span>
              ))}
            </div>
          )}
        </button>
        {t.priority === 'high' && !t.done && <span class="mt-[6px] w-1.5 h-1.5 bg-red shrink-0" title="High priority" />}
        {t.priority === 'low' && !t.done && <span class="mt-[2px] font-mono text-[9px] text-fg-3 shrink-0">LOW</span>}
      </div>
      {props.open && <TaskEditor t={t} onPatch={props.onPatch} onDelete={props.onDelete} />}
    </div>
  );
}

function TaskEditor(props: { t: Task; onPatch: (p: Partial<Task>) => void; onDelete: () => void }) {
  const t = props.t;
  const [title, setTitle] = useState(t.title);
  const [notes, setNotes] = useState(t.notes ?? '');
  const [tags, setTags] = useState((t.tags ?? []).join(', '));
  const commitText = () => {
    const p: Partial<Task> = {};
    if (title.trim() && title.trim() !== t.title) p.title = title.trim();
    if ((notes || '') !== (t.notes ?? '')) p.notes = notes;
    const tg = tags
      .split(/[,\s]+/)
      .map((x) => x.replace(/^#/, '').trim())
      .filter(Boolean);
    if (tg.join(',') !== (t.tags ?? []).join(',')) p.tags = tg;
    if (Object.keys(p).length) props.onPatch(p);
  };
  const lab = 'hud-label text-[9px]!';
  return (
    <div class="px-3 pb-3 pt-1 pl-9 flex flex-col gap-2">
      <input class="hud-input py-1! text-[13px]!" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} onBlur={commitText} aria-label="Title" />
      <textarea class="hud-input py-1.5! text-xs! min-h-14 resize-y" placeholder="Notes" value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} onBlur={commitText} aria-label="Notes" />
      <div class="grid grid-cols-2 gap-2">
        <label class="flex flex-col gap-1">
          <span class={lab}>Due</span>
          <input
            type="datetime-local"
            class="hud-input py-1! text-[11px]! font-mono"
            value={toLocalInput(t.due)}
            onChange={(e) => props.onPatch({ due: fromLocalInput((e.target as HTMLInputElement).value) })}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class={lab}>Remind at</span>
          <input
            type="datetime-local"
            class="hud-input py-1! text-[11px]! font-mono"
            value={toLocalInput(t.remindAt)}
            onChange={(e) => props.onPatch({ remindAt: fromLocalInput((e.target as HTMLInputElement).value) })}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class={lab}>Tags</span>
          <input class="hud-input py-1! text-[11px]! font-mono" value={tags} placeholder="home, work" onInput={(e) => setTags((e.target as HTMLInputElement).value)} onBlur={commitText} />
        </label>
        <label class="flex flex-col gap-1">
          <span class={lab}>Priority</span>
          <PrioritySelect value={t.priority} onChange={(p) => props.onPatch({ priority: p })} />
        </label>
      </div>
      <div class="flex items-center gap-2">
        {t.due && (
          <button class="font-mono text-[10px] text-fg-3 hover:text-fg tracking-wider" onClick={() => props.onPatch({ due: null })}>
            CLEAR DUE
          </button>
        )}
        {t.remindAt && (
          <button class="font-mono text-[10px] text-fg-3 hover:text-fg tracking-wider" onClick={() => props.onPatch({ remindAt: null })}>
            CLEAR REMINDER
          </button>
        )}
        <Btn size="xs" variant="ghost" class="ml-auto hover:text-red!" onClick={props.onDelete}>
          <Trash size={11} /> Delete
        </Btn>
      </div>
    </div>
  );
}
