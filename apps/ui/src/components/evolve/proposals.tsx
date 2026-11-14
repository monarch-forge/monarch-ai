/** Evolve → Proposals: ideas from reflection runs or the agent, reviewed by the user. */
import { useState } from 'preact/hooks';
import type { EvolutionProposal } from '@monarch/shared';
import { Blocks, BookText, ChevronDown, ChevronRight, Hammer, MessageSquare, X } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { toast, useResource } from '../../lib/store.ts';
import { Btn, Panel, Tag } from '../ui.tsx';
import { Markdown } from '../chat/markdown.tsx';
import { EvoGate, EvoNote, ago, errMsg, openSession, stamp } from './common.tsx';

export function ProposalsTab() {
  const res = useResource<EvolutionProposal[]>('/evolution/proposals', ['evolution']);
  const [showClosed, setShowClosed] = useState(false);
  const all = res.data ?? [];
  const open = all.filter((p) => p.status === 'open').sort((a, b) => b.ts.localeCompare(a.ts));
  const closed = all.filter((p) => p.status !== 'open').sort((a, b) => b.ts.localeCompare(a.ts));

  return (
    <Panel
      code="EVO.31"
      title="Proposals"
      class="h-full"
      noPad
      bodyClass="overflow-y-auto"
      right={
        res.data && (
          <>
            <Tag tone={open.length ? 'red' : 'plain'}>{open.length} open</Tag>
            {closed.length > 0 && (
              <Btn size="xs" variant="ghost" onClick={() => setShowClosed(!showClosed)} aria-pressed={showClosed}>
                {showClosed ? 'Hide' : 'Show'} closed · {closed.length}
              </Btn>
            )}
          </>
        )
      }
    >
      <EvoGate res={res} loadingLabel="Loading proposals">
        {() => (
          <div class="p-3 sm:p-4 flex flex-col gap-3">
            {open.length ? (
              <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {open.map((p) => (
                  <ProposalCard key={p.id} p={p} onChanged={res.reload} />
                ))}
              </div>
            ) : (
              <EvoNote
                icon
                label="No open proposals"
                sub="Reflection reviews recent sessions for friction — repeated manual steps, missing tools, failed calls — and suggests what Monarch could build. Run one with “Reflect now”."
              />
            )}
            {showClosed && closed.length > 0 && (
              <>
                <div class="hud-label text-[10px] mt-3 px-1">Closed</div>
                <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {closed.map((p) => (
                    <ProposalCard key={p.id} p={p} onChanged={res.reload} />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </EvoGate>
    </Panel>
  );
}

function ProposalCard(props: { p: EvolutionProposal; onChanged: () => Promise<void> }) {
  const { p } = props;
  const [planOpen, setPlanOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'accept' | 'dismiss'>(null);
  const isOpen = p.status === 'open';
  const Icon = p.kind === 'extension' ? Blocks : BookText;

  const act = async (kind: 'accept' | 'dismiss') => {
    setBusy(kind);
    try {
      if (kind === 'accept') {
        const r = await api.post<{ sessionId: string }>(`/evolution/proposals/${encodeURIComponent(p.id)}/accept`);
        toast('Build started', 'success');
        openSession(r?.sessionId);
      } else {
        await api.post(`/evolution/proposals/${encodeURIComponent(p.id)}/dismiss`);
        toast('Proposal dismissed', 'info');
        await props.onChanged();
      }
    } catch (e) {
      toast(`${kind === 'accept' ? 'Build' : 'Dismiss'} failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <article class={`border bg-[#121213]/40 flex flex-col min-w-0 ${isOpen ? 'border-line' : 'border-line/60 opacity-70'}`}>
      <header class="flex items-start gap-2.5 px-3.5 pt-3">
        <Icon size={14} strokeWidth={1.5} class={`mt-0.5 shrink-0 ${isOpen ? 'text-fg-2' : 'text-fg-3'}`} />
        <h3 class="flex-1 min-w-0 text-[14px] text-fg leading-snug">{p.title}</h3>
        <Tag tone="plain">{p.kind}</Tag>
        {!isOpen && <Tag tone={p.status === 'accepted' ? 'ok' : 'plain'}>{p.status}</Tag>}
      </header>
      <p class="px-3.5 pl-[38px] mt-1.5 text-[12.5px] text-fg-2 leading-relaxed">{p.rationale}</p>
      <div class="px-3.5 pl-[34px] mt-2">
        <button class="flex items-center gap-1 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 hover:text-fg-2 py-1" onClick={() => setPlanOpen(!planOpen)} aria-expanded={planOpen}>
          {planOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Plan
        </button>
        {planOpen && (
          <div class="border-l border-line ml-1.5 pl-3 mt-1 mb-1 text-[12.5px]">
            <Markdown text={p.plan} class="text-[12.5px]!" />
          </div>
        )}
      </div>
      <footer class="mt-auto flex items-center gap-2 px-3.5 py-2.5 border-t border-line/70 mt-3 flex-wrap">
        <span class="font-mono text-[10px] text-fg-3" title={stamp(p.ts)}>
          {ago(p.ts)}
        </span>
        {p.sessionId && (
          <button class="font-mono text-[10px] tracking-[0.1em] uppercase text-fg-3 hover:text-fg-2 flex items-center gap-1" onClick={() => openSession(p.sessionId)} title="Session that proposed this">
            <MessageSquare size={10} /> origin
          </button>
        )}
        {p.buildSessionId && (
          <button class="font-mono text-[10px] tracking-[0.1em] uppercase text-fg-2 hover:text-fg flex items-center gap-1" onClick={() => openSession(p.buildSessionId)}>
            <Hammer size={10} /> build session
          </button>
        )}
        {isOpen && (
          <span class="ml-auto flex gap-1.5">
            <Btn size="xs" variant="ghost" onClick={() => void act('dismiss')} loading={busy === 'dismiss'} disabled={busy !== null}>
              {busy !== 'dismiss' && <X size={11} />} Dismiss
            </Btn>
            <Btn size="xs" variant="primary" onClick={() => void act('accept')} loading={busy === 'accept'} disabled={busy !== null} title="Start a build session for this proposal">
              {busy !== 'accept' && <Hammer size={11} />} Build
            </Btn>
          </span>
        )}
      </footer>
    </article>
  );
}
