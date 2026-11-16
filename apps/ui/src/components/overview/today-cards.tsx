/** Overview home cards: "Waiting on you" and "Inbox". Calm, few numbers, friendly copy. */
import type { Briefing } from '@monarch/shared';
import { ArrowRight, CheckCircle2 } from 'lucide-preact';
import { approvals, navigate, notifications, type Resource } from '../../lib/store.ts';
import { displayToolName, focusApprovals } from '../approvals.tsx';
import { notificationsOpen } from '../notifications.tsx';
import { Panel } from '../ui.tsx';
import { Gate } from './common.tsx';

/** approvals + flags that are not purely informational */
export function WaitingCard(props: { res: Resource<Briefing>; class?: string }) {
  const pending = approvals.value;
  const flags = (props.res.data?.flags ?? []).filter((f) => f.level !== 'info');
  const total = pending.length + flags.length;
  return (
    <Panel title="Waiting on you" class={props.class} active={pending.length > 0} right={total > 0 ? <span class="text-[12px] text-fg-3 tabular-nums">{total}</span> : undefined}>
      {pending.length === 0 && flags.length === 0 && props.res.data === undefined ? (
        <Gate res={props.res}>{() => null}</Gate>
      ) : total === 0 ? (
        <AllClear text="Nothing waiting on you." />
      ) : (
        <ul class="flex flex-col -mx-2">
          {pending.slice(0, 3).map((a) => (
            <li key={a.id}>
              <button type="button" class="hud-row w-full text-left" onClick={focusApprovals}>
                <span class="inline-block w-1.5 h-1.5 rounded-full bg-red hud-blink shrink-0" />
                <span class="flex-1 min-w-0 truncate text-fg">{a.summary || `Allow ${displayToolName(a.tool)}?`}</span>
                <span class="text-[12px] text-fg-3 shrink-0">Review</span>
              </button>
            </li>
          ))}
          {flags.slice(0, Math.max(0, 4 - Math.min(3, pending.length))).map((f, i) => {
            const body = (
              <>
                <span class={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${f.level === 'error' ? 'bg-red' : 'bg-warning'}`} />
                <span class="flex-1 min-w-0 truncate text-fg-2">{f.text}</span>
                {f.href && <ArrowRight size={13} strokeWidth={1.6} class="text-fg-3 shrink-0" />}
              </>
            );
            return (
              <li key={i}>
                {f.href ? (
                  <a href={f.href} class="hud-row" title={f.text}>
                    {body}
                  </a>
                ) : (
                  <div class="hud-row" title={f.text}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** unread mail, open tasks and unread notifications as three quiet numbers */
export function InboxCard(props: { res: Resource<Briefing>; class?: string }) {
  const unreadNotes = notifications.value.filter((n) => !n.read).length;
  return (
    <Panel title="Inbox" class={props.class}>
      <Gate res={props.res}>
        {(b) => {
          const slackFlags = (b.flags ?? []).filter((f) => /slack/i.test(f.href ?? '') || f.tag === 'SLK').length;
          const rows = [
            { label: 'Unread mail', value: b.unreadMail, go: 'mail' },
            { label: 'Open tasks', value: b.openTasks, go: 'agenda' },
            { label: slackFlags ? 'Slack mentions' : 'Notifications', value: slackFlags || unreadNotes, go: slackFlags ? 'slack' : '' },
          ];
          if (rows.every((r) => !r.value)) return <AllClear text="Inbox zero. Enjoy the quiet." />;
          return (
            <div class="flex flex-col -mx-2">
              {rows.map((r) => (
                <button
                  type="button"
                  key={r.label}
                  class="hud-row w-full text-left"
                  onClick={() => (r.go ? navigate(r.go) : (notificationsOpen.value = true))}
                >
                  <span class="flex-1 text-fg-2">{r.label}</span>
                  <span class={`text-[15px] tabular-nums ${r.value ? 'text-fg font-medium' : 'text-fg-3'}`}>{r.value ?? 0}</span>
                </button>
              ))}
            </div>
          );
        }}
      </Gate>
    </Panel>
  );
}

function AllClear(props: { text: string }) {
  return (
    <div class="flex items-center gap-2.5 py-3 text-[13px] text-fg-2">
      <CheckCircle2 size={16} strokeWidth={1.6} class="text-success/80 shrink-0" />
      {props.text}
    </div>
  );
}
