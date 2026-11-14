/** Evolution timeline (audit log of every self-modification) + proposals store. Dependency-light on purpose. */
import type { EvolutionEntry, EvolutionKind, EvolutionProposal } from '@monarch/shared';
import { changed, newId, nowIso } from '../kernel.ts';
import { serviceStore } from '../services/persist.ts';

interface EvolutionFile {
  timeline: EvolutionEntry[];
  proposals: EvolutionProposal[];
  lastReflectionAt?: string;
  /** when periodic reflection was switched on (first run is one period after this) */
  reflectArmedAt?: string;
  skillsSeeded?: boolean;
}

export const evoStore = serviceStore<EvolutionFile>('evolution', { timeline: [], proposals: [] });

const TIMELINE_CAP = 1000;

export function record(
  kind: EvolutionKind,
  title: string,
  opts: { detail?: string; actor?: EvolutionEntry['actor']; sessionId?: string; ref?: string } = {},
): EvolutionEntry {
  const entry: EvolutionEntry = {
    id: newId(),
    ts: nowIso(),
    kind,
    title: title.slice(0, 200),
    detail: opts.detail?.slice(0, 4000),
    actor: opts.actor ?? 'system',
    sessionId: opts.sessionId || undefined,
    ref: opts.ref,
  };
  evoStore.update((s) => {
    s.timeline.unshift(entry);
    if (s.timeline.length > TIMELINE_CAP) s.timeline.length = TIMELINE_CAP;
  });
  changed('evolution');
  return entry;
}

export function timeline(limit = 100): EvolutionEntry[] {
  return evoStore.get().timeline.slice(0, Math.max(1, Math.min(limit, TIMELINE_CAP)));
}

export function listProposals(): EvolutionProposal[] {
  return evoStore.get().proposals;
}

export function getProposal(id: string): EvolutionProposal | undefined {
  return evoStore.get().proposals.find((p) => p.id === id);
}

export function addProposal(p: Omit<EvolutionProposal, 'id' | 'ts' | 'status'>, actor: EvolutionEntry['actor'] = 'agent'): EvolutionProposal {
  const proposal: EvolutionProposal = { ...p, id: newId(), ts: nowIso(), status: 'open' };
  evoStore.update((s) => {
    s.proposals.unshift(proposal);
    if (s.proposals.length > 300) s.proposals.length = 300;
  });
  record('proposal.created', `Proposed: ${proposal.title}`, { detail: proposal.rationale, actor, sessionId: p.sessionId, ref: proposal.id });
  return proposal;
}

export function patchProposal(id: string, fn: (p: EvolutionProposal) => void): EvolutionProposal | undefined {
  const p = getProposal(id);
  if (!p) return undefined;
  fn(p);
  evoStore.save();
  changed('evolution');
  return p;
}
