/** "Background agent" block: the three built-in jobs (triage, ledger import, morning brief) + what they handled. */
import { useState } from 'preact/hooks';
import type { BackgroundJob, BackgroundStatus } from '@monarch/shared';
import { Play } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { toast, useResource } from '../../lib/store.ts';
import { relTime } from '../mail/kit.tsx';

const LABEL: Record<BackgroundJob, [string, string]> = {
  triage: ['Triage', 'Every 2h, weekdays 8–20: archive noise, mark low-value chats read, draft replies'],
  ledgerImport: ['Ledger import', 'Hourly: record bank/card emails in the ledger'],
  morningBrief: ['Morning brief', 'Daily: build the brief shown on Overview'],
};

export function BackgroundSection() {
  const res = useResource<BackgroundStatus>('/background', ['automations']);
  const [busy, setBusy] = useState<string | null>(null);
  const s = res.data;
  if (!s) return null;

  const patch = async (p: Record<string, unknown>) => {
    try {
      res.setData(await api.patch<BackgroundStatus>('/background', p));
    } catch (e: any) {
      toast(`Update failed: ${e?.message ?? e}`, 'error');
    }
  };
  const run = async (job: BackgroundJob) => {
    setBusy(job);
    try {
      await api.post(`/background/${job}/run`);
      toast(`Running ${LABEL[job][0].toLowerCase()}`, 'success');
    } catch (e: any) {
      toast(`Run failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(null);
      void res.reload();
    }
  };

  return (
    <div class="px-2.5 pt-1 pb-3 mb-2 border-b border-subtle">
      <div class="text-[12px] font-medium text-fg-2 mb-1">Background agent</div>
      {s.jobs.map((j) => (
        <div key={j.job} class="py-1.5">
          <div class="flex items-center gap-2">
            <span class="text-[13px] text-fg" title={LABEL[j.job][1]}>
              {LABEL[j.job][0]}
            </span>
            {j.job === 'morningBrief' && (
              <input type="time" class="input input-xs w-[92px]" value={s.briefTime} aria-label="Brief time" onChange={(e) => void patch({ briefTime: (e.target as HTMLInputElement).value })} />
            )}
            <span class="ml-auto flex items-center gap-1">
              <button class="p-1 rounded-md text-fg-3 hover:text-fg disabled:opacity-40" title="Run now" aria-label={`Run ${LABEL[j.job][0]} now`} disabled={j.running || busy === j.job} onClick={() => void run(j.job)}>
                {j.running || busy === j.job ? <span class="loading loading-spinner loading-xs" /> : <Play size={12} />}
              </button>
              <input type="checkbox" class="toggle toggle-xs ml-1" checked={j.enabled} aria-label={`${j.enabled ? 'Disable' : 'Enable'} ${LABEL[j.job][0]}`} onChange={() => void patch({ [j.job]: !j.enabled })} />
            </span>
          </div>
          <div class="text-[12px] text-fg-3 leading-snug">
            {j.lastRunAt ? (
              <span title={j.lastResult ?? ''}>
                {j.lastStatus === 'error' ? <span class="text-red/90">failed</span> : 'ran'} {relTime(j.lastRunAt)}
                {j.enabled && j.nextRunAt ? ` · next ${relTime(j.nextRunAt)}` : ''}
              </span>
            ) : (
              LABEL[j.job][1]
            )}
          </div>
        </div>
      ))}
      {s.log.length > 0 && (
        <details class="mt-1">
          <summary class="text-[12px] text-fg-3 cursor-pointer">What I handled</summary>
          <ul class="mt-1 flex flex-col gap-0.5">
            {s.log.slice(0, 10).map((e, i) => (
              <li key={i} class="text-[12px] text-fg-2 leading-snug">
                <span class="text-fg-3">{relTime(e.at)} · </span>
                {e.summary}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
