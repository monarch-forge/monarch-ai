/** Evolve → Timeline: audit log of every self-modification. */
import { useMemo, useState } from 'preact/hooks';
import type { EvolutionEntry, EvolutionKind } from '@monarch/shared';
import type { LucideIcon } from 'lucide-preact';
import { AlertTriangle, BookText, Check, FilePlus2, FileMinus2, FilePen, Lightbulb, MessageSquare, Power, PowerOff, Sparkles, Undo2, X } from 'lucide-preact';
import { useResource } from '../../lib/store.ts';
import { Panel, Tag } from '../ui.tsx';
import { EvoGate, EvoNote, ago, openSession, stamp } from './common.tsx';

const KIND: Record<EvolutionKind, { label: string; icon: LucideIcon; tone?: 'red' | 'fg' }> = {
  'extension.created': { label: 'Extension created', icon: FilePlus2, tone: 'fg' },
  'extension.updated': { label: 'Extension updated', icon: FilePen },
  'extension.removed': { label: 'Extension removed', icon: FileMinus2 },
  'extension.enabled': { label: 'Extension enabled', icon: Power, tone: 'fg' },
  'extension.disabled': { label: 'Extension disabled', icon: PowerOff },
  'extension.rollback': { label: 'Rolled back', icon: Undo2 },
  'extension.error': { label: 'Extension error', icon: AlertTriangle, tone: 'red' },
  'skill.created': { label: 'Skill learned', icon: BookText, tone: 'fg' },
  'skill.updated': { label: 'Skill refined', icon: BookText },
  'skill.removed': { label: 'Skill removed', icon: BookText },
  'proposal.created': { label: 'Proposal', icon: Lightbulb },
  'proposal.accepted': { label: 'Proposal accepted', icon: Check, tone: 'fg' },
  'proposal.dismissed': { label: 'Proposal dismissed', icon: X },
  reflection: { label: 'Reflection', icon: Sparkles },
};

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'extension', label: 'Extensions' },
  { id: 'skill', label: 'Skills' },
  { id: 'proposal', label: 'Proposals' },
  { id: 'reflection', label: 'Reflection' },
] as const;

function refHref(e: EvolutionEntry): string | null {
  if (!e.ref || e.kind.endsWith('.removed')) return null;
  if (e.kind.startsWith('extension.')) return `#/evolve/extensions/${encodeURIComponent(e.ref)}`;
  if (e.kind.startsWith('skill.')) return `#/evolve/skills/${encodeURIComponent(e.ref)}`;
  if (e.kind.startsWith('proposal.')) return '#/evolve/proposals';
  return null;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function TimelineTab() {
  const res = useResource<EvolutionEntry[]>('/evolution/timeline?limit=200', ['evolution', 'extensions', 'skills']);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [actor, setActor] = useState<'all' | 'agent' | 'user' | 'system'>('all');

  const groups = useMemo(() => {
    const list = (res.data ?? [])
      .filter((e) => filter === 'all' || e.kind.startsWith(filter))
      .filter((e) => actor === 'all' || e.actor === actor)
      .sort((a, b) => b.ts.localeCompare(a.ts));
    const out: { day: string; items: EvolutionEntry[] }[] = [];
    for (const e of list) {
      const day = dayLabel(e.ts);
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(e);
    }
    return out;
  }, [res.data, filter, actor]);

  return (
    <Panel code="EVO.41" title="Timeline" class="h-full" noPad bodyClass="flex flex-col" right={res.data && <Tag tone="plain">{res.data.length} entries</Tag>}>
      <div class="flex items-center gap-1.5 px-3 py-2 border-b border-line flex-wrap">
        <div class="flex gap-1 flex-wrap" role="group" aria-label="Filter by kind">
          {FILTERS.map((f) => (
            <Chip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </Chip>
          ))}
        </div>
        <div class="ml-auto flex gap-1" role="group" aria-label="Filter by actor">
          {(['all', 'agent', 'user', 'system'] as const).map((a) => (
            <Chip key={a} on={actor === a} onClick={() => setActor(a)}>
              {a === 'all' ? 'Anyone' : a}
            </Chip>
          ))}
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto">
        <EvoGate res={res} loadingLabel="Loading timeline">
          {() =>
            groups.length ? (
              <div class="px-4 py-3 max-w-[920px]">
                {groups.map((g) => (
                  <section key={g.day} class="mb-4 last:mb-0">
                    <div class="hud-label text-[10px] mb-2 sticky top-0 bg-surface py-1 z-[1]">{g.day}</div>
                    <ol class="relative border-l border-line ml-[7px]">
                      {g.items.map((e) => (
                        <TimelineItem key={e.id} e={e} />
                      ))}
                    </ol>
                  </section>
                ))}
              </div>
            ) : (
              <EvoNote icon label={res.data?.length ? 'Nothing matches' : 'No changes yet'} sub={res.data?.length ? undefined : 'Every extension, skill, proposal and reflection Monarch makes is recorded here.'} />
            )
          }
        </EvoGate>
      </div>
    </Panel>
  );
}

function TimelineItem(props: { e: EvolutionEntry }) {
  const { e } = props;
  const k = KIND[e.kind] ?? { label: e.kind, icon: Sparkles };
  const Icon = k.icon;
  const href = refHref(e);
  return (
    <li class="relative pl-6 pb-3.5 last:pb-1">
      <span class={`absolute -left-[8px] top-0 w-[15px] h-[15px] flex items-center justify-center bg-surface border ${k.tone === 'red' ? 'border-red/60 text-red' : k.tone === 'fg' ? 'border-fg-3 text-fg' : 'border-line text-fg-3'}`}>
        <Icon size={9} strokeWidth={2} />
      </span>
      <div class="flex items-baseline gap-x-2.5 gap-y-0.5 flex-wrap">
        <span class={`font-mono text-[10px] tracking-[0.12em] uppercase ${k.tone === 'red' ? 'text-red' : 'text-fg-3'}`}>{k.label}</span>
        <span class="font-mono text-[10px] text-fg-3 tabular-nums" title={stamp(e.ts)}>
          {new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} · {ago(e.ts)}
        </span>
        <span class={`font-mono text-[10px] tracking-[0.1em] uppercase ${e.actor === 'agent' ? 'text-fg-2' : 'text-fg-3'}`}>by {e.actor}</span>
      </div>
      <div class="text-[13px] text-fg mt-0.5 leading-snug">
        {href ? (
          <a href={href} class="hover:underline decoration-red underline-offset-2">
            {e.title}
          </a>
        ) : (
          e.title
        )}
      </div>
      {e.detail && <div class="text-[12px] text-fg-3 mt-0.5 leading-relaxed whitespace-pre-wrap break-words">{e.detail}</div>}
      {(e.sessionId || (href && e.ref)) && (
        <div class="flex items-center gap-3 mt-1">
          {href && e.ref && (
            <a href={href} class="font-mono text-[10px] text-fg-3 hover:text-fg-2">
              {e.ref}
            </a>
          )}
          {e.sessionId && (
            <button class="font-mono text-[10px] tracking-[0.1em] uppercase text-fg-3 hover:text-fg-2 flex items-center gap-1" onClick={() => openSession(e.sessionId)}>
              <MessageSquare size={10} /> session
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function Chip(props: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      class={`font-mono text-[10px] tracking-[0.12em] uppercase px-2 py-0.5 border ${props.on ? 'border-fg-3 text-fg bg-subtle' : 'border-line text-fg-3 hover:text-fg-2'}`}
      aria-pressed={props.on}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
