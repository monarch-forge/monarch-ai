/** Workshop details: open GitHub PRs needing me (via the core's `gh` CLI). */
import { GitPullRequest, RefreshCw } from 'lucide-preact';
import { openExternal } from '../lib/api.ts';
import { useResource } from '../lib/store.ts';
import { askMonarch } from './mail/kit.tsx';

interface GhPr {
  number: number;
  title: string;
  url: string;
  repo: string;
  draft: boolean;
  ci: string | null;
  reason: 'review' | 'mine' | 'assigned';
}

const CI_TONE: Record<string, string> = { SUCCESS: 'text-success', FAILURE: 'text-error', ERROR: 'text-error', PENDING: 'text-warning', EXPECTED: 'text-warning' };

export function PrPanel() {
  const res = useResource<{ prs: GhPr[]; error?: string }>('/api/github/prs', [], { intervalMs: 5 * 60_000 });
  const prs = res.data?.prs ?? [];
  if (!prs.length) return null; // no gh / not logged in / nothing pending: stay out of the way
  return (
    <div>
      <div class="flex items-center gap-2 mb-1.5">
        <span class="text-[12px] text-fg-3">
          <GitPullRequest size={12} strokeWidth={1.75} class="inline -mt-0.5 mr-1" />
          Pull requests · {prs.length}
        </span>
        <button class="ml-auto text-fg-3 hover:text-fg-2" title="Refresh" onClick={() => void res.reload()}>
          <RefreshCw size={12} strokeWidth={1.75} />
        </button>
      </div>
      <div class="flex flex-col">
        {prs.slice(0, 12).map((p) => (
          <div key={p.url} class="py-1 group">
            <button class="block w-full text-left text-[12.5px] text-fg-2 truncate hover:underline" title={p.title} onClick={() => void openExternal(p.url)}>
              {p.title}
            </button>
            <div class="flex items-center gap-1 text-[11px] text-fg-3">
              <span class="truncate">
                {p.repo}#{p.number} · {p.reason === 'review' ? 'review requested' : p.reason}
                {p.draft ? ' · draft' : ''} · <span class={CI_TONE[p.ci ?? ''] ?? ''}>CI {p.ci?.toLowerCase() ?? 'none'}</span>
              </span>
              {p.reason !== 'mine' && (
                <button
                  class="ml-auto shrink-0 text-fg-3 hover:text-fg-2 underline"
                  onClick={() => askMonarch(`Review PR ${p.url} and draft comments; don't post until I approve.`)}
                >
                  Review with agent
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
