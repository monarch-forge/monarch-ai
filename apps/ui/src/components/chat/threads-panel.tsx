/**
 * Open-threads board of a chat session (agent working memory): open/waiting threads first, then a few done.
 * The right column of the Chat page (a drawer on narrow windows); refetches on data.changed 'threads'.
 */
import type { ChatThread, ThreadLink } from '@monarch/shared';
import { useResource } from '../../lib/store.ts';
import { Glyph, Skeleton } from '../ui.tsx';
import { useSessions } from '../../lib/chat-store.ts';

function href(l: ThreadLink): string | undefined {
  if (l.kind === 'worker') return `#/workshop/${encodeURIComponent(l.ref)}`;
  if (/^https?:\/\//.test(l.ref)) return l.ref;
  return undefined;
}

export function ThreadsPanel(props: { sessionId: string }) {
  const res = useResource<ChatThread[]>(`/api/sessions/${encodeURIComponent(props.sessionId)}/threads`, ['threads']);
  const workers = useSessions('coding').sessions ?? [];
  const all = res.data ?? [];
  const live = all.filter((t) => t.status !== 'done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const done = all.filter((t) => t.status === 'done').length;
  return (
    <div class="flex flex-col gap-3">
      <div class="ds-label pb-1.5">
        Threads{live.length ? ` · ${live.length} open` : ''}
        {done ? ` · ${done} done` : ''}
      </div>
      {res.loading && !res.data ? (
        <Skeleton lines={3} />
      ) : live.length === 0 ? (
        <p class="text-[12.5px] text-fg-3 leading-relaxed">Nothing open. Ongoing work and follow-ups show up here.</p>
      ) : (
        live.map((t) => {
          const wl = t.links.find((l) => l.kind === 'worker');
          const plan = wl ? workers.find((w) => w.id === wl.ref)?.plan : undefined;
          const planDone = plan?.filter((p) => p.status !== 'open').length ?? 0;
          const status = t.needsReport ? 'needs report' : t.status;
          return (
            <div key={t.id} class="rounded-[18px] border border-[var(--border-default)] p-4 flex flex-col gap-2.5">
              <div class="flex justify-between gap-2 text-[11px] tracking-[0.12em] uppercase">
                <span class={t.needsReport ? 'text-red' : t.status === 'waiting' ? 'text-warning' : 'text-fg-2'}>{status}</span>
                <span class="text-fg-3 truncate">{t.area}</span>
              </div>
              <span class="text-[14px] text-fg leading-snug">{t.title}</span>
              {plan && plan.length > 0 && <Glyph value={planDone} of={plan.length} live={workers.find((w) => w.id === wl!.ref)?.running} class="w-full [&>i]:flex-1" title={`${planDone} of ${plan.length} steps`} />}
              {t.links.length > 0 && (
                <div class="flex flex-wrap gap-x-2 gap-y-1">
                  {t.links.map((l) => {
                    const h = href(l);
                    const label = l.label || `${l.kind} ${l.ref.slice(0, 12)}`;
                    return h ? (
                      <a key={`${l.kind}:${l.ref}`} href={h} target={h.startsWith('#') ? undefined : '_blank'} rel="noreferrer" class="text-[12px] text-fg-2 underline decoration-fg-3 underline-offset-[3px] hover:text-fg truncate max-w-[12rem]">
                        {label}
                      </a>
                    ) : (
                      <span key={`${l.kind}:${l.ref}`} class="text-[12px] text-fg-3 truncate max-w-[12rem]">
                        {label}
                      </span>
                    );
                  })}
                </div>
              )}
              {t.next && <span class="text-[12px] text-fg-3">Next: {t.next}</span>}
            </div>
          );
        })
      )}
    </div>
  );
}
