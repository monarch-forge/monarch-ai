/** Home right column (Glyph command): Needs you, Agents, Next, Inbox. Outlined cards, dot-matrix numbers. */
import type { ComponentChildren } from 'preact';
import type { Briefing, SessionSummary } from '@monarch/shared';
import { approvals, navigate, notifications, type Resource } from '../../lib/store.ts';
import { displayToolName, focusApprovals, respondApproval } from '../approvals.tsx';
import { notificationsOpen } from '../notifications.tsx';
import { DotText, Glyph, Skeleton } from '../ui.tsx';

const pad2 = (n: number) => String(n).padStart(2, '0');

function Card(props: { label: string; red?: boolean; right?: ComponentChildren; class?: string; children: ComponentChildren }) {
  return (
    <section class={`rounded-[20px] border p-5 flex flex-col gap-3 min-w-0 ${props.red ? 'border-red' : 'border-line'} ${props.class ?? ''}`}>
      <header class="flex items-center justify-between gap-2">
        <span class={`ds-label ${props.red ? '!text-red' : ''}`}>{props.label}</span>
        {props.right}
      </header>
      {props.children}
    </section>
  );
}

/** first pending approval with Approve / Review; falls back to the briefing's non-info flags */
export function NeedsYouCard(props: { res: Resource<Briefing> }) {
  const pending = approvals.value;
  const flags = (props.res.data?.flags ?? []).filter((f) => f.level !== 'info');
  const a = pending[0];
  if (a) {
    return (
      <Card label="Needs you" red right={<DotText class="text-[28px] leading-none text-red">{pad2(pending.length)}</DotText>}>
        <span class="text-[15px] text-fg line-clamp-2">{a.summary || `Allow ${displayToolName(a.tool)}?`}</span>
        <div class="flex gap-2">
          <button type="button" class="flex-1 h-9 rounded-full bg-red hover:bg-red-hover text-white text-[12px] font-semibold uppercase tracking-[0.08em]" onClick={() => respondApproval(a.id, true)}>
            Approve
          </button>
          <button type="button" class="flex-1 h-9 rounded-full border border-line text-fg-2 hover:text-fg text-[12px] uppercase tracking-[0.08em]" onClick={focusApprovals}>
            Review
          </button>
        </div>
      </Card>
    );
  }
  return (
    <Card label="Needs you" right={<DotText class={`text-[28px] leading-none ${flags.length ? 'text-fg' : 'text-fg-3'}`}>{pad2(flags.length)}</DotText>}>
      {props.res.data === undefined && !props.res.error ? (
        <Skeleton lines={2} />
      ) : flags.length === 0 ? (
        <span class="text-[13px] text-fg-3">Nothing waiting on you.</span>
      ) : (
        <ul class="flex flex-col gap-2">
          {flags.slice(0, 3).map((f, i) => (
            <li key={i} class="flex items-center gap-2.5 text-[13px] min-w-0">
              <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${f.level === 'error' ? 'bg-red' : 'bg-warning'}`} />
              {f.href ? (
                <a href={f.href} class="truncate text-fg-2 hover:text-fg" title={f.text}>
                  {f.text}
                </a>
              ) : (
                <span class="truncate text-fg-2" title={f.text}>
                  {f.text}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** running workers (coding or delegated) with plan progress */
export function AgentsCard(props: { res: Resource<SessionSummary[]> }) {
  const workers = (props.res.data ?? []).filter((s) => s.running && (s.kind === 'coding' || s.parentSessionId));
  return (
    <Card label="Agents" right={workers.length > 0 ? <DotText class="text-[13px] text-fg-2">{pad2(workers.length)}</DotText> : undefined}>
      {props.res.data === undefined && !props.res.error ? (
        <Skeleton lines={2} />
      ) : workers.length === 0 ? (
        <span class="text-[13px] text-fg-3">No agents running.</span>
      ) : (
        <ul class="flex flex-col gap-3.5">
          {workers.slice(0, 4).map((s) => {
            const plan = s.plan ?? [];
            const done = plan.filter((p) => p.status !== 'open').length;
            return (
              <li key={s.id}>
                <a href={`#/chat/${s.id}`} class="flex flex-col gap-1.5 group">
                  <span class="flex justify-between gap-3 text-[13px]">
                    <span class="truncate text-fg group-hover:underline">{s.title || 'Worker'}</span>
                    {plan.length > 0 && (
                      <DotText class="text-fg-2 shrink-0">
                        {done}/{plan.length}
                      </DotText>
                    )}
                  </span>
                  {plan.length > 0 ? <Glyph value={done} of={Math.min(plan.length, 12)} live /> : <Glyph value={1} of={1} live />}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** next calendar event from the briefing */
export function NextCard(props: { res: Resource<Briefing> }) {
  const ev = props.res.data?.nextEvent;
  const start = ev ? new Date(ev.start) : null;
  const mins = ev?.end && start ? Math.round((Date.parse(ev.end) - start.getTime()) / 60_000) : 0;
  return (
    <Card label="Next" class="gap-2">
      {props.res.data === undefined && !props.res.error ? (
        <Skeleton lines={2} />
      ) : !ev || !start ? (
        <>
          <DotText class="text-[40px] leading-none text-fg-3">--:--</DotText>
          <span class="text-[12px] text-fg-3">Nothing scheduled</span>
        </>
      ) : (
        <button type="button" class="text-left flex flex-col gap-2" onClick={() => navigate('agenda')}>
          <DotText class="text-[40px] leading-none text-fg">{ev.allDay ? 'DAY' : start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</DotText>
          <span class="text-[12px] text-fg-3 truncate" title={ev.title}>
            {ev.title}
            {mins > 0 && !ev.allDay ? ` · ${mins >= 60 ? `${Math.round(mins / 6) / 10}h` : `${mins}m`}` : ''}
          </span>
        </button>
      )}
    </Card>
  );
}

/** unread mail, Slack mentions and open tasks as dot-matrix counts */
export function InboxCard(props: { res: Resource<Briefing> }) {
  const b = props.res.data;
  const unreadNotes = notifications.value.filter((n) => !n.read).length;
  // shortcut: briefing has no Slack unread count (needs live API calls); Slack = Slack flags. Upgrade if the briefing carries it.
  const slack = (b?.flags ?? []).filter((f) => /slack/i.test(f.href ?? '') || f.tag === 'SLK').length;
  const cells = [
    { label: 'Mail', value: b?.unreadMail ?? 0, go: () => navigate('mail') },
    slack ? { label: 'Slack', value: slack, go: () => navigate('slack') } : { label: 'Alerts', value: unreadNotes, go: () => (notificationsOpen.value = true) },
    b?.unreadWhatsApp ? { label: 'WA', value: b.unreadWhatsApp, go: () => navigate('whatsapp') } : { label: 'Tasks', value: b?.openTasks ?? 0, go: () => navigate('agenda') },
  ];
  return (
    <Card label="Inbox" class="gap-2">
      {b === undefined && !props.res.error ? (
        <Skeleton lines={2} />
      ) : (
        <div class="flex gap-3.5 flex-wrap">
          {cells.map((c) => (
            <button type="button" key={c.label} class="flex flex-col text-left" onClick={c.go}>
              <DotText class={`text-[30px] leading-none ${c.value ? 'text-fg' : 'text-fg-3'}`}>{pad2(c.value)}</DotText>
              <span class="text-[10px] uppercase tracking-[0.12em] text-fg-3">{c.label}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
