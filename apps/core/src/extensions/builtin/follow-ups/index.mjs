/**
 * Follow-ups — the open loops of a busy week, in one place.
 *
 * Two kinds of item:
 *   owe      something I promised someone ("send Ana the deck by Friday")
 *   waiting  something someone owes me ("legal sign-off from Tom")
 *
 * Shows: zod-validated tools with clear risk levels, a small versioned api.store schema,
 * a once-a-day digest job (api.job + api.notify) and a panel (stats + items + markdown).
 * Needs no permissions: no network, no secrets, only its own data dir.
 *
 * Store schema (key "items", version 1):
 *   { id, kind: 'owe'|'waiting', text, who?, due?: 'YYYY-MM-DD', note?, createdAt, doneAt? }
 */

const MAX_ITEMS = 500; // open + done; the oldest done items are dropped first
const DIGEST_HOUR = 8; // local hour after which the daily digest may fire

/** local calendar date as YYYY-MM-DD (en-CA formats that way) */
const localDay = (d = new Date()) => d.toLocaleDateString('en-CA');
const addDays = (day, n) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86_400_000);

/**
 * Accepts "2026-11-20", "today", "tomorrow", "+3d", "+2w", or a weekday ("friday" = the next one).
 * Returns YYYY-MM-DD or throws with a message the agent can act on.
 */
function parseDue(raw) {
  const s = String(raw).trim().toLowerCase();
  const today = localDay();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00`))) return s;
  if (s === 'today') return today;
  if (s === 'tomorrow') return addDays(today, 1);
  const rel = s.match(/^\+(\d{1,3})\s*([dw])$/);
  if (rel) return addDays(today, Number(rel[1]) * (rel[2] === 'w' ? 7 : 1));
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const wd = days.findIndex((d) => d.startsWith(s) && s.length >= 3);
  if (wd >= 0) {
    const diff = (wd - new Date(`${today}T12:00:00`).getDay() + 7) % 7 || 7;
    return addDays(today, diff);
  }
  throw new Error(`Unrecognised due date "${raw}". Use YYYY-MM-DD, today, tomorrow, +3d, +2w or a weekday.`);
}

export default function activate(api) {
  const { z, store } = api;

  /* ── storage ── */
  const all = () => store.get('items', []);
  const save = (items) => {
    if (items.length > MAX_ITEMS) {
      const open = items.filter((i) => !i.doneAt);
      const done = items.filter((i) => i.doneAt).sort((a, b) => b.doneAt.localeCompare(a.doneAt));
      items = [...open, ...done.slice(0, Math.max(0, MAX_ITEMS - open.length))];
    }
    store.set('items', items);
  };
  const nextId = () => {
    const n = store.get('seq', 0) + 1;
    store.set('seq', n);
    return n;
  };
  const open = () => all().filter((i) => !i.doneAt);

  /* ── presentation ── */
  function when(i, today = localDay()) {
    if (!i.due) return 'no date';
    const d = daysBetween(today, i.due);
    if (d < 0) return `overdue ${-d}d`;
    if (d === 0) return 'due today';
    if (d === 1) return 'due tomorrow';
    return `due ${i.due}`;
  }
  const line = (i) =>
    `#${i.id} [${i.kind === 'owe' ? 'I owe' : 'waiting on'}${i.who ? ` ${i.who}` : ''}] ${i.text} — ${when(i)}`;
  /** overdue first, then by due date, undated last, then oldest first */
  const byUrgency = (a, b) =>
    (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.createdAt.localeCompare(b.createdAt);
  function find(id) {
    const items = all();
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`No follow-up #${id}. Use follow_ups_list to see ids.`);
    return { items, item };
  }
  function counts(today = localDay()) {
    const o = open();
    return {
      open: o.length,
      overdue: o.filter((i) => i.due && i.due < today).length,
      today: o.filter((i) => i.due === today).length,
      owe: o.filter((i) => i.kind === 'owe').length,
      waiting: o.filter((i) => i.kind === 'waiting').length,
    };
  }

  /* ── tools ── */
  api.tool({
    name: 'add',
    description:
      'Track a follow-up: something the user promised ("owe") or is waiting on from someone ("waiting"). ' +
      'Use whenever a commitment or dependency comes up in mail, chat or meetings. Returns the new item id.',
    input: z.object({
      text: z.string().min(1).max(300).describe('What needs to happen, e.g. "Send Q3 deck"'),
      kind: z.enum(['owe', 'waiting']).default('owe').describe('"owe" = user promised it; "waiting" = someone owes the user'),
      who: z.string().max(80).optional().describe('Person or team involved'),
      due: z.string().max(20).optional().describe('YYYY-MM-DD, today, tomorrow, +3d, +2w, or a weekday like "friday"'),
      note: z.string().max(1000).optional().describe('Context: link, thread subject, where it was agreed'),
    }),
    run: ({ text, kind, who, due, note }) => {
      const item = {
        id: nextId(),
        kind,
        text: text.trim(),
        ...(who?.trim() ? { who: who.trim() } : {}),
        ...(due ? { due: parseDue(due) } : {}),
        ...(note?.trim() ? { note: note.trim() } : {}),
        createdAt: new Date().toISOString(),
      };
      save([...all(), item]);
      return `Added ${line(item)}`;
    },
  });

  api.tool({
    name: 'list',
    description:
      'List follow-ups, most urgent first. Filter by kind, person, or only those due within N days. ' +
      'Use for "what am I waiting on", "what do I owe Ana", or planning the day.',
    risk: 'safe',
    input: z.object({
      kind: z.enum(['owe', 'waiting', 'all']).default('all'),
      who: z.string().max(80).optional().describe('Case-insensitive substring match on the person'),
      withinDays: z.number().int().min(0).max(365).optional().describe('Only items due within N days (overdue included)'),
      includeDone: z.boolean().default(false).describe('Also show the 20 most recently completed'),
    }),
    run: ({ kind, who, withinDays, includeDone }) => {
      const today = localDay();
      let items = open();
      if (kind !== 'all') items = items.filter((i) => i.kind === kind);
      if (who) items = items.filter((i) => i.who?.toLowerCase().includes(who.toLowerCase()));
      if (withinDays !== undefined) {
        const limit = addDays(today, withinDays);
        items = items.filter((i) => i.due && i.due <= limit);
      }
      const out = items.sort(byUrgency).map((i) => line(i) + (i.note ? `\n    ${i.note}` : ''));
      let text = out.length ? out.join('\n') : 'No open follow-ups match.';
      if (includeDone) {
        const done = all()
          .filter((i) => i.doneAt)
          .sort((a, b) => b.doneAt.localeCompare(a.doneAt))
          .slice(0, 20);
        if (done.length) text += `\n\nRecently done:\n${done.map((i) => `#${i.id} ✓ ${i.text} (${i.doneAt.slice(0, 10)})`).join('\n')}`;
      }
      return text;
    },
  });

  api.tool({
    name: 'done',
    description: 'Mark a follow-up as done (it stays in history). Use when the user delivered it or received what they waited for.',
    input: z.object({ id: z.number().int().positive().describe('Item id from follow_ups_list') }),
    run: ({ id }) => {
      const { items, item } = find(id);
      if (item.doneAt) return `#${id} was already done on ${item.doneAt.slice(0, 10)}.`;
      item.doneAt = new Date().toISOString();
      save(items);
      const left = counts().open;
      return `Done: ${item.text}. ${left} open follow-up${left === 1 ? '' : 's'} left.`;
    },
  });

  api.tool({
    name: 'update',
    description: 'Change the due date (snooze), text, person or note of a follow-up. Pass due "none" to clear the date.',
    input: z.object({
      id: z.number().int().positive(),
      due: z.string().max(20).optional().describe('New due date (same formats as add) or "none"'),
      text: z.string().min(1).max(300).optional(),
      who: z.string().max(80).optional(),
      note: z.string().max(1000).optional(),
    }),
    run: ({ id, due, text, who, note }) => {
      const { items, item } = find(id);
      if (due !== undefined) {
        if (due.trim().toLowerCase() === 'none') delete item.due;
        else item.due = parseDue(due);
      }
      if (text !== undefined) item.text = text.trim();
      if (who !== undefined) item.who = who.trim() || undefined;
      if (note !== undefined) item.note = note.trim() || undefined;
      save(items);
      return `Updated ${line(item)}`;
    },
  });

  api.tool({
    name: 'remove',
    description: 'Delete a follow-up entirely (for mistakes or duplicates — prefer "done" for completed ones).',
    risk: 'dangerous',
    input: z.object({ id: z.number().int().positive() }),
    run: ({ id }) => {
      const { items, item } = find(id);
      save(items.filter((i) => i !== item));
      return `Removed #${id}: ${item.text}`;
    },
  });

  /* ── daily digest: checks hourly, notifies at most once per local day, only if something is due ── */
  api.job({
    id: 'daily-digest',
    everyMinutes: 60,
    run: () => {
      const now = new Date();
      const today = localDay(now);
      if (now.getHours() < DIGEST_HOUR || store.get('lastDigest') === today) return;
      store.set('lastDigest', today);
      const due = open().filter((i) => i.due && i.due <= today).sort(byUrgency);
      if (!due.length) return;
      const c = counts(today);
      const head = [c.overdue && `${c.overdue} overdue`, c.today && `${c.today} due today`].filter(Boolean).join(', ');
      const body = due.slice(0, 3).map((i) => `• ${i.text}${i.who ? ` (${i.who})` : ''}`).join('\n');
      api.notify(`Follow-ups: ${head}`, due.length > 3 ? `${body}\n…and ${due.length - 3} more` : body);
      api.log.info(`digest sent: ${head}`);
    },
  });

  /* ── panel ── */
  api.panel({
    id: 'open',
    title: 'Follow-ups',
    render: () => {
      const today = localDay();
      const c = counts(today);
      const items = open().sort(byUrgency);
      return {
        stats: [
          { label: 'Open', value: String(c.open), hint: `${c.owe} I owe · ${c.waiting} waiting` },
          { label: 'Overdue', value: String(c.overdue) },
          { label: 'Due today', value: String(c.today) },
        ],
        items: items.slice(0, 12).map((i) => ({
          title: `${i.kind === 'owe' ? '→' : '←'} ${i.text}`,
          sub: [i.who, when(i, today)].filter(Boolean).join(' · '),
        })),
        markdown: items.length
          ? items.length > 12
            ? `_${items.length - 12} more — ask Monarch to list follow-ups._`
            : undefined
          : 'Nothing open. Ask Monarch to *"track that I owe Ana the deck by Friday"* or *"remind me I\'m waiting on legal"*.',
      };
    },
  });
}
