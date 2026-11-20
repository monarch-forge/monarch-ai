/**
 * Open-threads board of a chat session (agent working memory): open/waiting threads first, then a few done.
 * The right column of the Chat page (a drawer on narrow windows); refetches on data.changed 'threads'.
 */
import type { ChatThread, ThreadLink } from '@monarch/shared';
import { useResource } from '../../lib/store.ts';
import { Tag, Skeleton } from '../ui.tsx';

function href(l: ThreadLink): string | undefined {
  if (l.kind === 'worker') return `#/workshop/${encodeURIComponent(l.ref)}`;
  if (/^https?:\/\//.test(l.ref)) return l.ref;
  return undefined;
}

export function ThreadsPanel(props: { sessionId: string }) {
  const res = useResource<ChatThread[]>(`/api/sessions/${encodeURIComponent(props.sessionId)}/threads`, ['threads']);
  const all = res.data ?? [];
  const live = all.filter((t) => t.status !== 'done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const done = all.filter((t) => t.status === 'done').length;
  return (
    <div>
      <div class="text-[12px] text-fg-3 mb-2 px-0.5">
        Threads{live.length ? ` · ${live.length} open` : ''}
        {done ? ` · ${done} done` : ''}
      </div>
      {res.loading && !res.data ? (
        <Skeleton lines={3} />
      ) : live.length === 0 ? (
        <p class="text-[12.5px] text-fg-3 leading-relaxed px-0.5">Nothing open. Ongoing work and follow-ups show up here.</p>
      ) : (
        <ul class="flex flex-col gap-2">
          {live.map((t) => (
            <li key={t.id} class="rounded-[var(--radius-control)] bg-raised px-3 py-2.5 text-[13px] leading-snug">
              <div class="truncate text-fg">{t.title}</div>
              <div class="flex flex-wrap items-center gap-1 mt-1.5">
                <Tag>{t.area}</Tag>
                <Tag tone={t.needsReport ? 'red' : t.status === 'waiting' ? 'warn' : 'plain'}>{t.needsReport ? 'needs report' : t.status}</Tag>
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
              {t.next && <div class="text-[12px] text-fg-3 mt-1.5">Next: {t.next}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
