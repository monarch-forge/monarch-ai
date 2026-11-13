/** Tasks + reminders (local, persisted in data/tasks.json). */
import type { Task } from '@monarch/shared';
import { activity, changed, HttpError, newId, notify, nowIso } from '../kernel.ts';
import { serviceStore } from './persist.ts';
import { fmtLocal, isoOrNull } from './dates.ts';

const store = serviceStore<Task[]>('tasks', []);
/** taskId -> remindAt value we already fired for (re-arms when remindAt changes) */
const reminded = serviceStore<Record<string, string>>('task-reminders', {});

const PRIORITIES = ['low', 'normal', 'high'] as const;
const PRIO_RANK: Record<Task['priority'], number> = { high: 0, normal: 1, low: 2 };

export interface TaskInput {
  title?: string;
  notes?: string;
  due?: string | null;
  remindAt?: string | null;
  priority?: Task['priority'];
  tags?: string[];
  done?: boolean;
}

export interface TaskFilter {
  /** true = only completed, false = only open, undefined = all */
  done?: boolean;
  tag?: string;
  /** substring match on title/notes */
  q?: string;
  /** only tasks due before this instant */
  dueBefore?: Date;
}

function sortTasks(a: Task, b: Task): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  const ad = a.due ? Date.parse(a.due) : Infinity;
  const bd = b.due ? Date.parse(b.due) : Infinity;
  if (ad !== bd) return ad - bd;
  if (a.priority !== b.priority) return PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
  return b.createdAt.localeCompare(a.createdAt);
}

export function listTasks(filter: TaskFilter = {}): Task[] {
  const q = filter.q?.toLowerCase();
  return store
    .get()
    .filter((t) => {
      if (filter.done !== undefined && t.done !== filter.done) return false;
      if (filter.tag && !t.tags.some((x) => x.toLowerCase() === filter.tag!.toLowerCase())) return false;
      if (q && !`${t.title}\n${t.notes ?? ''}`.toLowerCase().includes(q)) return false;
      if (filter.dueBefore && (!t.due || Date.parse(t.due) >= filter.dueBefore.getTime())) return false;
      return true;
    })
    .sort(sortTasks);
}

export function getTask(id: string): Task {
  const t = store.get().find((x) => x.id === id);
  if (!t) throw new HttpError(404, `Task ${id} not found`);
  return t;
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean))];
}

export function createTask(input: TaskInput): Task {
  const title = input.title?.trim();
  if (!title) throw new HttpError(400, 'title is required');
  if (input.priority && !PRIORITIES.includes(input.priority)) throw new HttpError(400, 'priority must be low|normal|high');
  const task: Task = {
    id: newId(),
    title,
    notes: input.notes?.trim() || undefined,
    due: isoOrNull(input.due) ?? null,
    remindAt: isoOrNull(input.remindAt) ?? null,
    priority: input.priority ?? 'normal',
    done: !!input.done,
    tags: cleanTags(input.tags),
    createdAt: nowIso(),
    completedAt: input.done ? nowIso() : null,
  };
  store.update((a) => {
    a.push(task);
  });
  changed('tasks');
  activity('TSK', `Task added: ${task.title}`);
  return task;
}

export function updateTask(id: string, patch: TaskInput): Task {
  const t = getTask(id);
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new HttpError(400, 'title cannot be empty');
    t.title = title;
  }
  if (patch.notes !== undefined) t.notes = patch.notes?.trim() || undefined;
  if (patch.due !== undefined) t.due = isoOrNull(patch.due) ?? null;
  if (patch.remindAt !== undefined) t.remindAt = isoOrNull(patch.remindAt) ?? null;
  if (patch.priority !== undefined) {
    if (!PRIORITIES.includes(patch.priority)) throw new HttpError(400, 'priority must be low|normal|high');
    t.priority = patch.priority;
  }
  if (patch.tags !== undefined) t.tags = cleanTags(patch.tags);
  if (patch.done !== undefined && patch.done !== t.done) {
    t.done = patch.done;
    t.completedAt = patch.done ? nowIso() : null;
    activity('TSK', `${patch.done ? 'Completed' : 'Reopened'}: ${t.title}`);
  }
  store.save();
  changed('tasks');
  return t;
}

export function deleteTask(id: string): Task {
  const t = getTask(id);
  store.update((a) => a.filter((x) => x.id !== id));
  reminded.update((r) => {
    delete r[id];
  });
  changed('tasks');
  activity('TSK', `Task deleted: ${t.title}`);
  return t;
}

/** fire due reminders; called by the scheduler every ~30s */
export function checkReminders(now = Date.now()): void {
  const fired = reminded.get();
  let dirty = false;
  for (const t of store.get()) {
    if (t.done || !t.remindAt) continue;
    const at = Date.parse(t.remindAt);
    if (Number.isNaN(at) || at > now || fired[t.id] === t.remindAt) continue;
    fired[t.id] = t.remindAt;
    dirty = true;
    // reminders missed by more than 12h (core was off) are marked silently instead of flooding
    if (now - at > 12 * 3600e3) continue;
    const due = t.due ? ` — due ${fmtLocal(t.due)}` : '';
    notify('Reminder', `${t.title}${due}`, 'warn', '#/agenda');
    activity('TSK', `Reminder: ${t.title}`, 'warn');
  }
  // forget reminder marks for tasks that no longer exist
  const ids = new Set(store.get().map((t) => t.id));
  for (const id of Object.keys(fired)) if (!ids.has(id)) (delete fired[id], (dirty = true));
  if (dirty) reminded.save();
}
