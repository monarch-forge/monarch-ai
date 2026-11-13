/** Automations panel: scheduled prompts Monarch runs on its own. List, toggle, run now, create/edit modal. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Automation } from '@monarch/shared';
import { Play, Pencil, Plus, Trash, ArrowUpRight } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { toast, useResource } from '../../lib/store.ts';
import { Btn, Panel, Tag } from '../ui.tsx';
import { Button, LoadError, Loading, Modal, relTime, StateBlock, useConfirm } from '../mail/kit.tsx';

const PRESETS: { id: string; label: string; schedule: string }[] = [
  { id: 'weekday8', label: 'Every weekday 08:00', schedule: '0 8 * * 1-5' },
  { id: 'daily8', label: 'Daily 08:00', schedule: 'daily 08:00' },
  { id: 'daily18', label: 'Daily 18:00', schedule: 'daily 18:00' },
  { id: '30m', label: 'Every 30 min', schedule: 'every 30m' },
  { id: '2h', label: 'Every 2 hours', schedule: 'every 2h' },
  { id: 'mon9', label: 'Mondays 09:00', schedule: '0 9 * * 1' },
];

export const EXAMPLES: { name: string; schedule: string; prompt: string; notify: boolean }[] = [
  {
    name: 'Morning briefing',
    schedule: '0 8 * * 1-5',
    prompt:
      "Prepare my morning briefing: today's calendar across all accounts, tasks due today or overdue, unread important mail (summarize, don't open newsletters), Slack mentions since yesterday, and the weather. Keep it to a tight bulleted list and flag anything that needs a decision.",
    notify: true,
  },
  {
    name: 'Inbox triage',
    schedule: 'every 2h',
    prompt:
      'Triage new unread mail in all my Gmail accounts since the last run. Summarize anything important in one line each, propose replies as Gmail drafts where a reply is clearly needed (never send), and create tasks for action items with due dates when mentioned.',
    notify: true,
  },
  {
    name: 'Slack digest',
    schedule: 'daily 17:30',
    prompt:
      'Give me a digest of today in my Slack workspaces: direct messages and mentions first, then decisions and announcements per active channel. Flag unanswered questions directed at me.',
    notify: true,
  },
];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function describeSchedule(s: string): string {
  const t = (s ?? '').trim();
  let m = t.match(/^every\s+(\d+)\s*([mh])$/i);
  if (m) return `Every ${m[1]}${m[2].toLowerCase() === 'm' ? ' min' : m[1] === '1' ? ' hour' : ' hours'}`;
  m = t.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (m) return `Daily ${m[1].padStart(2, '0')}:${m[2]}`;
  m = t.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\S+)$/);
  if (m) {
    const time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
    const d = m[3];
    if (d === '*') return `Daily ${time}`;
    if (d === '1-5') return `Weekdays ${time}`;
    if (d === '0,6' || d === '6,0') return `Weekends ${time}`;
    if (/^[0-6](,[0-6])*$/.test(d)) return `${d.split(',').map((x) => DOW[Number(x)]).join(', ')} ${time}`;
  }
  m = t.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (m) return `Every ${m[1]} min`;
  return t || '—';
}

export function AutomationsPanel(props: { class?: string }) {
  const res = useResource<Automation[]>('/automations', ['automations']);
  const list = useMemo(
    () => (Array.isArray(res.data) ? res.data.filter((a) => a && typeof a.id === 'string') : []).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
    [res.data],
  );
  const [edit, setEdit] = useState<Partial<Automation> | null>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [runs, setRuns] = useState<Record<string, string>>({});

  const patch = async (a: Automation, p: Partial<Automation>) => {
    const prev = res.data;
    if (prev) res.setData(prev.map((x) => (x.id === a.id ? { ...x, ...p } : x)));
    try {
      await api.patch(`/automations/${encodeURIComponent(a.id)}`, p);
    } catch (e: any) {
      if (prev) res.setData(prev);
      toast(`Update failed: ${e?.message ?? e}`, 'error');
    }
  };

  const run = async (a: Automation) => {
    setRunning((r) => ({ ...r, [a.id]: true }));
    try {
      const out = await api.post<{ sessionId: string }>(`/automations/${encodeURIComponent(a.id)}/run`);
      if (out?.sessionId) setRuns((r) => ({ ...r, [a.id]: out.sessionId }));
      toast(`Running “${a.name}” — open its session from the Automations panel`, 'success');
    } catch (e: any) {
      toast(`Run failed: ${e?.message ?? e}`, 'error');
    } finally {
      setRunning((r) => ({ ...r, [a.id]: false }));
    }
  };

  return (
    <Panel
      code="AUT.01"
      title="Automations"
      class={props.class}
      noPad
      bodyClass="flex flex-col min-h-0"
      right={
        <>
          <Tag>{list.filter((a) => a.enabled).length} active</Tag>
          <button class="text-fg-3 hover:text-fg" title="New automation" aria-label="New automation" onClick={() => setEdit({ notify: true, enabled: true, schedule: '0 8 * * 1-5' })}>
            <Plus size={14} />
          </button>
        </>
      }
    >
      <div class="flex-1 min-h-0 overflow-y-auto">
        {res.error && !res.data ? (
          <LoadError error={res.error} onRetry={res.reload} />
        ) : res.data === undefined ? (
          <Loading label="Loading automations" />
        ) : !list.length ? (
          <StateBlock title="No automations">
            <div>Let Monarch work on a schedule. Start from an example:</div>
            <div class="flex flex-wrap justify-center gap-1.5 mt-3">
              {EXAMPLES.map((x) => (
                <Btn key={x.name} size="xs" onClick={() => setEdit({ ...x, enabled: true })}>
                  {x.name}
                </Btn>
              ))}
            </div>
          </StateBlock>
        ) : (
          list.map((a) => (
            <div key={a.id} class={`group px-3 py-2.5 border-b border-line/60 ${a.enabled ? '' : 'opacity-60'}`}>
              <div class="flex items-center gap-2">
                <span
                  class={`w-1.5 h-1.5 shrink-0 ${a.lastStatus === 'error' ? 'bg-red' : a.enabled ? 'bg-success' : 'border border-fg-3'}`}
                  title={a.lastStatus === 'error' ? 'Last run failed' : a.enabled ? 'Enabled' : 'Disabled'}
                />
                <button class="text-[13px] text-fg truncate text-left hover:underline decoration-fg-3 underline-offset-2" onClick={() => setEdit(a)}>
                  {a.name}
                </button>
                <span class="ml-auto flex items-center gap-1">
                  <button class="p-1 text-fg-3 hover:text-fg opacity-0 group-hover:opacity-100 focus:opacity-100" title="Edit" aria-label={`Edit ${a.name}`} onClick={() => setEdit(a)}>
                    <Pencil size={12} />
                  </button>
                  <button class="p-1 text-fg-3 hover:text-fg disabled:opacity-40" title="Run now" aria-label={`Run ${a.name} now`} disabled={running[a.id]} onClick={() => void run(a)}>
                    {running[a.id] ? <span class="loading loading-spinner loading-xs" /> : <Play size={12} />}
                  </button>
                  <input
                    type="checkbox"
                    class="toggle toggle-xs ml-1 checked:bg-red checked:border-red"
                    checked={a.enabled}
                    onChange={() => void patch(a, { enabled: !a.enabled })}
                    aria-label={a.enabled ? `Disable ${a.name}` : `Enable ${a.name}`}
                  />
                </span>
              </div>
              <div class="flex items-center gap-2 mt-1 pl-3.5 font-mono text-[10px] text-fg-3">
                <span class="text-fg-2" title={a.schedule}>
                  {describeSchedule(a.schedule)}
                </span>
                {a.enabled && a.nextRunAt && <span title={new Date(a.nextRunAt).toLocaleString()}>· next {relTime(a.nextRunAt)}</span>}
                {a.lastRunAt && (
                  <span class="ml-auto" title={new Date(a.lastRunAt).toLocaleString()}>
                    {a.lastStatus === 'error' ? <span class="text-red">ERR</span> : a.lastStatus === 'ok' ? 'OK' : ''} {relTime(a.lastRunAt)}
                  </span>
                )}
              </div>
              {a.lastResult && <div class={`pl-3.5 mt-1 text-[11px] leading-snug line-clamp-2 ${a.lastStatus === 'error' ? 'text-red/90' : 'text-fg-3'}`}>{a.lastResult}</div>}
              {runs[a.id] && (
                <a href={`#/comms/${encodeURIComponent(runs[a.id])}`} class="pl-3.5 mt-1 inline-flex items-center gap-1 font-mono text-[10px] tracking-wider text-fg-2 hover:text-fg">
                  VIEW RUN <ArrowUpRight size={10} />
                </a>
              )}
            </div>
          ))
        )}
      </div>
      <AutomationModal value={edit} onClose={() => setEdit(null)} onSaved={() => void res.reload()} />
    </Panel>
  );
}

function AutomationModal(props: { value: Partial<Automation> | null; onClose: () => void; onSaved: () => void }) {
  const v = props.value;
  const [f, setF] = useState({ name: '', schedule: '', prompt: '', notify: true, enabled: true });
  const [preset, setPreset] = useState('custom');
  const [busy, setBusy] = useState(false);
  const [dialog, confirm] = useConfirm();
  useEffect(() => {
    if (!v) return;
    const schedule = v.schedule ?? '0 8 * * 1-5';
    setF({ name: v.name ?? '', schedule, prompt: v.prompt ?? '', notify: v.notify ?? true, enabled: v.enabled ?? true });
    setPreset(PRESETS.find((p) => p.schedule === schedule)?.id ?? 'custom');
  }, [v]);

  const editing = !!v?.id;
  const valid = f.name.trim() && f.prompt.trim() && f.schedule.trim();

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const body = { name: f.name.trim(), schedule: f.schedule.trim(), prompt: f.prompt.trim(), notify: f.notify, enabled: f.enabled };
    try {
      if (editing) await api.patch(`/automations/${encodeURIComponent(v!.id!)}`, body);
      else await api.post('/automations', body);
      toast(editing ? 'Automation updated' : 'Automation created', 'success');
      props.onSaved();
      props.onClose();
    } catch (e: any) {
      toast(`Save failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!v?.id) return;
    if (!(await confirm({ title: 'Delete automation', body: `Delete “${v.name}”? It will stop running.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/automations/${encodeURIComponent(v.id)}`);
      toast('Automation deleted', 'success');
      props.onSaved();
      props.onClose();
    } catch (e: any) {
      toast(`Delete failed: ${e?.message ?? e}`, 'error');
    }
  };

  const lab = 'hud-label';
  return (
    <>
      <Modal
        open={!!v}
        onClose={props.onClose}
        code="AUT.E"
        title={editing ? 'Edit automation' : 'New automation'}
        width="max-w-xl"
        footer={
          <>
            {editing && (
              <Btn variant="ghost" class="mr-auto hover:text-red!" onClick={remove}>
                <Trash size={12} /> Delete
              </Btn>
            )}
            <Btn variant="ghost" onClick={props.onClose}>
              Cancel
            </Btn>
            <Button variant="primary" loading={busy} disabled={!valid} onClick={save}>
              {editing ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        <div class="flex flex-col gap-3">
          {!editing && (
            <div class="flex flex-wrap items-center gap-1.5">
              <span class={`${lab} mr-1`}>Examples</span>
              {EXAMPLES.map((x) => (
                <button
                  key={x.name}
                  class="font-mono text-[10px] tracking-wider uppercase border border-line px-1.5 py-0.5 text-fg-2 hover:text-fg hover:border-fg-3"
                  onClick={() => {
                    setF({ ...f, name: x.name, schedule: x.schedule, prompt: x.prompt, notify: x.notify });
                    setPreset(PRESETS.find((p) => p.schedule === x.schedule)?.id ?? 'custom');
                  }}
                >
                  {x.name}
                </button>
              ))}
            </div>
          )}
          <label class="flex flex-col gap-1.5">
            <span class={lab}>Name</span>
            <input class="hud-input" value={f.name} onInput={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} placeholder="Morning briefing" />
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="flex flex-col gap-1.5">
              <span class={lab}>Schedule</span>
              <select
                class="select select-sm w-full bg-[#121213] border-line text-[13px] rounded-[2px]"
                value={preset}
                onChange={(e) => {
                  const id = (e.target as HTMLSelectElement).value;
                  setPreset(id);
                  const p = PRESETS.find((x) => x.id === id);
                  if (p) setF({ ...f, schedule: p.schedule });
                }}
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </label>
            <label class="flex flex-col gap-1.5">
              <span class={lab}>Expression</span>
              <input
                class="hud-input font-mono text-[13px]! py-1.5!"
                value={f.schedule}
                onInput={(e) => {
                  const s = (e.target as HTMLInputElement).value;
                  setF({ ...f, schedule: s });
                  setPreset(PRESETS.find((p) => p.schedule === s.trim())?.id ?? 'custom');
                }}
                placeholder="0 8 * * 1-5 · every 30m · daily 08:00"
              />
            </label>
          </div>
          <div class="font-mono text-[10px] text-fg-3 -mt-1.5">→ {describeSchedule(f.schedule)} · cron (5 fields), “every 30m / 2h” or “daily HH:MM”</div>
          <label class="flex flex-col gap-1.5">
            <span class={lab}>Prompt</span>
            <textarea
              class="hud-input min-h-32 resize-y text-[13px]! leading-relaxed"
              value={f.prompt}
              onInput={(e) => setF({ ...f, prompt: (e.target as HTMLTextAreaElement).value })}
              placeholder="What should Monarch do each time it runs?"
            />
          </label>
          <div class="flex items-center gap-5">
            <label class="flex items-center gap-2 text-xs text-fg-2 cursor-pointer">
              <input type="checkbox" class="toggle toggle-xs checked:bg-red checked:border-red" checked={f.notify} onChange={(e) => setF({ ...f, notify: (e.target as HTMLInputElement).checked })} />
              Notify me with the result
            </label>
            <label class="flex items-center gap-2 text-xs text-fg-2 cursor-pointer">
              <input type="checkbox" class="toggle toggle-xs checked:bg-red checked:border-red" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: (e.target as HTMLInputElement).checked })} />
              Enabled
            </label>
          </div>
        </div>
      </Modal>
      {dialog}
    </>
  );
}
