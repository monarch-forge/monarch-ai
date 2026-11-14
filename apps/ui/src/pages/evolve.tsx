/**
 * EVOLVE — watch and steer Monarch extending itself: extensions, skills, proposals, the audit timeline
 * and the tool catalog. Route: #/evolve/<tab>/<id?>/<sub?>
 *   #/evolve/extensions/:id/(overview|panels|source|logs|history)   ("new" = editor)
 *   #/evolve/skills/:id                                             ("new" = editor)
 *   #/evolve/proposals · #/evolve/timeline · #/evolve/tools
 */
import type { LucideIcon } from 'lucide-preact';
import { Blocks, BookText, History, Lightbulb, Wrench } from 'lucide-preact';
import type { EvolutionStats } from '@monarch/shared';
import { navigate, useResource } from '../lib/store.ts';
import { EvolveHeader } from '../components/evolve/header.tsx';
import { ExtensionsTab } from '../components/evolve/extensions.tsx';
import { SkillsTab } from '../components/evolve/skills.tsx';
import { ProposalsTab } from '../components/evolve/proposals.tsx';
import { TimelineTab } from '../components/evolve/timeline.tsx';
import { ToolsTab } from '../components/evolve/tools.tsx';

const TABS: { id: string; label: string; icon: LucideIcon; count?: (s: EvolutionStats) => number | string; attention?: (s: EvolutionStats) => boolean }[] = [
  { id: 'extensions', label: 'Extensions', icon: Blocks, count: (s) => s.extensions.total, attention: (s) => s.extensions.error > 0 },
  { id: 'skills', label: 'Skills', icon: BookText, count: (s) => s.skills },
  { id: 'proposals', label: 'Proposals', icon: Lightbulb, count: (s) => s.openProposals, attention: (s) => s.openProposals > 0 },
  { id: 'timeline', label: 'Timeline', icon: History },
  { id: 'tools', label: 'Tools', icon: Wrench, count: (s) => s.tools.always + s.tools.deferred },
];

export default function EvolvePage(props: { params: string[] }) {
  const [tabId, id, sub] = props.params;
  const tab = TABS.find((t) => t.id === tabId) ?? TABS[0];
  const stats = useResource<EvolutionStats>('/evolution/stats', ['evolution', 'extensions', 'skills']);
  const st = stats.data;

  return (
    <div class="h-full overflow-y-auto lg:overflow-hidden">
      <div class="flex flex-col gap-3 p-3 lg:h-full min-h-full">
        <EvolveHeader stats={stats} />

        <nav class="flex items-stretch border-b border-line overflow-x-auto [scrollbar-width:none] shrink-0 -mt-1" role="tablist" aria-label="Evolve sections">
          {TABS.map((t, i) => {
            const Icon = t.icon;
            const on = t.id === tab.id;
            const count = st && t.count ? t.count(st) : undefined;
            const attn = st && t.attention ? t.attention(st) : false;
            return (
              <a
                key={t.id}
                href={`#/evolve/${t.id}`}
                role="tab"
                aria-selected={on}
                aria-current={on ? 'page' : undefined}
                class="hud-nav !h-10 shrink-0"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
                    navigate(`evolve/${n.id}`);
                    requestAnimationFrame(() => document.querySelector<HTMLElement>(`a[href="#/evolve/${n.id}"]`)?.focus());
                  }
                }}
              >
                <Icon size={13} strokeWidth={1.5} />
                <span>{t.label}</span>
                {count !== undefined && <span class={`text-[10px] tabular-nums ${attn ? 'text-red' : 'text-fg-3'}`}>{count}</span>}
              </a>
            );
          })}
        </nav>

        <div class="h-[78vh] lg:h-auto lg:flex-1 lg:min-h-0 shrink-0 lg:shrink" role="tabpanel" aria-label={tab.label}>
          {tab.id === 'extensions' && <ExtensionsTab id={id} sub={sub} />}
          {tab.id === 'skills' && <SkillsTab id={id} />}
          {tab.id === 'proposals' && <ProposalsTab />}
          {tab.id === 'timeline' && <TimelineTab />}
          {tab.id === 'tools' && <ToolsTab />}
        </div>
      </div>
    </div>
  );
}
