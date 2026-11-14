/**
 * Focus Timer — pomodoro sessions that survive restarts.
 *
 * Shows: persistent state with api.store, a background job (runs every minute in this sandbox),
 * api.notify for the user, and a panel with stats + items.
 */
const DAY = (d = new Date()) => d.toISOString().slice(0, 10);

export default function activate(api) {
  const { z, store } = api;

  /** @returns {{ label: string, minutes: number, startedAt: string, endsAt: string } | null} */
  const current = () => store.get('session', null);
  /** @returns {{ label: string, minutes: number, endedAt: string, completed: boolean }[]} */
  const history = () => store.get('history', []);
  const remainingMin = (s) => Math.max(0, Math.ceil((Date.parse(s.endsAt) - Date.now()) / 60_000));

  function finish(completed) {
    const s = current();
    if (!s) return null;
    const minutes = completed
      ? s.minutes
      : Math.max(0, Math.round((Date.now() - Date.parse(s.startedAt)) / 60_000));
    const entry = { label: s.label, minutes, endedAt: new Date().toISOString(), completed };
    store.set('history', [entry, ...history()].slice(0, 200));
    store.delete('session');
    return entry;
  }

  function today() {
    const list = history().filter((h) => h.endedAt.slice(0, 10) === DAY());
    return { sessions: list.filter((h) => h.completed).length, minutes: list.reduce((n, h) => n + h.minutes, 0) };
  }

  api.tool({
    name: 'start',
    description: 'Start a focus session (default 25 minutes). Replaces a running session.',
    risk: 'safe',
    input: z.object({
      minutes: z.number().int().min(1).max(240).default(25),
      label: z.string().max(80).default('Focus'),
    }),
    run: ({ minutes, label }) => {
      if (current()) finish(false);
      const now = Date.now();
      store.set('session', {
        label,
        minutes,
        startedAt: new Date(now).toISOString(),
        endsAt: new Date(now + minutes * 60_000).toISOString(),
      });
      return `Started "${label}" for ${minutes} min — I'll notify you when it ends.`;
    },
  });

  api.tool({
    name: 'status',
    description: "Current focus session (if any) and today's totals.",
    risk: 'safe',
    run: () => {
      const s = current();
      const t = today();
      const head = s ? `Running: "${s.label}" — ${remainingMin(s)} of ${s.minutes} min left.` : 'No focus session running.';
      return `${head}\nToday: ${t.sessions} completed session(s), ${t.minutes} focus minutes.`;
    },
  });

  api.tool({
    name: 'stop',
    description: 'Stop the running focus session early (it is logged as partial).',
    risk: 'safe',
    run: () => {
      const e = finish(false);
      return e ? `Stopped "${e.label}" after ${e.minutes} min.` : 'No focus session was running.';
    },
  });

  api.job({
    id: 'check',
    everyMinutes: 1,
    run: () => {
      const s = current();
      if (!s || Date.parse(s.endsAt) > Date.now()) return;
      const e = finish(true);
      api.notify('Focus session complete', `"${e.label}" — ${e.minutes} min done. Time for a break.`);
      api.log.info(`completed "${e.label}" (${e.minutes} min)`);
    },
  });

  api.panel({
    id: 'status',
    title: 'Focus',
    render: () => {
      const s = current();
      const t = today();
      return {
        stats: [
          { label: 'Now', value: s ? `${remainingMin(s)} min left` : 'idle', hint: s?.label },
          { label: 'Sessions today', value: String(t.sessions) },
          { label: 'Focus today', value: `${t.minutes} min` },
        ],
        items: history()
          .slice(0, 8)
          .map((h) => ({
            title: `${h.completed ? '✓' : '·'} ${h.label}`,
            sub: `${h.minutes} min · ${new Date(h.endedAt).toLocaleString()}`,
          })),
      };
    },
  });
}
