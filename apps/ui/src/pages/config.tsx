/**
 * CONFIG — settings, models, providers, accounts, permissions (route #/config/<tab>). UI-B.
 */
import type { ComponentType } from 'preact';
import type { LucideIcon } from 'lucide-preact';
import { UserRound, Cpu, KeyRound, Link2, ShieldCheck, Dna, AudioLines, RefreshCcw, FolderGit2 } from 'lucide-preact';
import { conn, health, navigate, settings } from '../lib/store.ts';
import { Panel, Tag, ErrorLine, PageHeader } from '../components/ui.tsx';
import { SettingsGate } from '../components/config/fields.tsx';
import { GeneralSection } from '../components/config/general.tsx';
import { ModelsSection } from '../components/config/models.tsx';
import { ProvidersSection } from '../components/config/providers.tsx';
import { AccountsSection } from '../components/config/accounts.tsx';
import { PermissionsSection } from '../components/config/permissions.tsx';
import { EvolutionSection } from '../components/config/evolution.tsx';
import { VoiceSection } from '../components/config/voice.tsx';
import { SyncSection } from '../components/config/sync.tsx';
import { ProjectsSection } from '../components/config/projects.tsx';
import { RemoteSection } from '../components/config/remote.tsx';
import { Smartphone } from 'lucide-preact';
import { useEffect } from 'preact/hooks';

type Section = { id: string; label: string; icon: LucideIcon; page: ComponentType; needsSettings: boolean };
// Old per-section ids stay valid deep links (#/config/<id>): they open their group and scroll to the section.
const S: Record<string, Section> = {
  general: { id: 'general', label: 'General', icon: UserRound, page: GeneralSection, needsSettings: true },
  voice: { id: 'voice', label: 'Voice', icon: AudioLines, page: VoiceSection, needsSettings: true },
  models: { id: 'models', label: 'Models', icon: Cpu, page: ModelsSection, needsSettings: true },
  providers: { id: 'providers', label: 'Providers', icon: KeyRound, page: ProvidersSection, needsSettings: false },
  permissions: { id: 'permissions', label: 'Permissions', icon: ShieldCheck, page: PermissionsSection, needsSettings: true },
  evolution: { id: 'evolution', label: 'Evolution', icon: Dna, page: EvolutionSection, needsSettings: true },
  accounts: { id: 'accounts', label: 'Accounts', icon: Link2, page: AccountsSection, needsSettings: false },
  projects: { id: 'projects', label: 'Projects', icon: FolderGit2, page: ProjectsSection, needsSettings: false },
  remote: { id: 'remote', label: 'Phone access', icon: Smartphone, page: RemoteSection, needsSettings: false },
  sync: { id: 'sync', label: 'Sync', icon: RefreshCcw, page: SyncSection, needsSettings: true },
};

const TABS: { id: string; label: string; icon: LucideIcon; sections: Section[] }[] = [
  { id: 'you', label: 'You', icon: UserRound, sections: [S.general, S.voice] },
  { id: 'ai', label: 'AI', icon: Cpu, sections: [S.models, S.providers, S.permissions, S.evolution] },
  { id: 'connections', label: 'Connections', icon: Link2, sections: [S.accounts, S.projects, S.remote] },
  { id: 'data', label: 'Data', icon: RefreshCcw, sections: [S.sync] },
];

export default function ConfigPage(props: { params: string[] }) {
  const id = props.params[0];
  const tab = TABS.find((t) => t.id === id || t.sections.some((x) => x.id === id)) ?? TABS[0];
  useEffect(() => {
    if (id && S[id]) requestAnimationFrame(() => document.getElementById(`cfg-${id}`)?.scrollIntoView({ block: 'start' }));
  }, [id]);
    const s = settings.value;

  return (
    <div class="h-full overflow-y-auto lg:overflow-hidden">
      <div class="lg:h-full flex flex-col lg:grid lg:grid-cols-[232px_minmax(0,1fr)] gap-2 lg:gap-6 px-4 lg:px-6 pt-4 lg:pt-6">
        <nav
          class="flex lg:flex-col gap-0.5 overflow-x-auto [scrollbar-width:none] lg:overflow-visible shrink-0 -mx-1 px-1 lg:mx-0 lg:px-0"
          aria-label="Settings sections"
        >
          <div class="hidden lg:block px-3 pb-4 text-[20px] font-semibold tracking-[-0.01em] text-fg">Settings</div>
          {TABS.map((t, i) => {
            const Icon = t.icon;
            const on = t.id === tab.id;
            return (
              <a
                key={t.id}
                href={`#/config/${t.id}`}
                class={`relative flex items-center gap-2.5 shrink-0 rounded-[var(--radius-control)] px-3 py-2.5 text-[13.5px] transition-colors duration-150 ${
                  on ? 'bg-raised text-fg' : 'text-fg-2 hover:bg-raised/60 hover:text-fg'
                }`}
                aria-current={on ? 'page' : undefined}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const n = TABS[(i + (e.key === 'ArrowDown' ? 1 : -1) + TABS.length) % TABS.length];
                    navigate(`config/${n.id}`);
                    requestAnimationFrame(() => document.querySelector<HTMLElement>(`a[href="#/config/${n.id}"]`)?.focus());
                  }
                }}
              >
                {on && <span class="hidden lg:block absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-red" aria-hidden="true" />}
                <Icon size={15} strokeWidth={1.6} class={on ? 'text-fg' : 'text-fg-3'} />
                <span>{t.label}</span>
              </a>
            );
          })}
          <div class="hidden lg:flex flex-col gap-1 mt-auto px-3 py-4 text-[12px] text-fg-3">
            <span class="flex items-center gap-2">
              <span class={`inline-block w-1.5 h-1.5 rounded-full ${conn.value === 'open' ? 'bg-success' : 'bg-warning'}`} />
              {conn.value === 'open' ? 'Core connected' : 'Core offline'}
            </span>
            {(health.value || s) && (
              <span class="font-mono text-[11px]">
                {health.value ? `v${health.value.version}` : ''}
                {s ? ` · ${s.engine === 'pi' ? 'pi' : 'claude sdk'}` : ''}
              </span>
            )}
          </div>
        </nav>

        <div class="lg:min-h-0 lg:overflow-y-auto">
          <div class="max-w-[760px] flex flex-col gap-7 pb-12">
            <PageHeader class="pt-1 pb-2" title={<span class="ds-dot uppercase text-[30px] leading-none text-fg">{tab.label}</span>} right={conn.value !== 'open' ? <Tag tone="warn">core offline</Tag> : undefined} />
            {tab.sections.map((sec) => {
              const Page = sec.page;
              const SecIcon = sec.icon;
              return (
                <section key={sec.id} id={`cfg-${sec.id}`} class="flex flex-col gap-3 scroll-mt-4">
                  <h2 class="flex items-center gap-2 ds-label px-1">
                    <SecIcon size={15} strokeWidth={1.6} class="text-fg-3" />
                    {sec.label}
                  </h2>
                  {conn.value !== 'open' && !s && sec.needsSettings ? (
                    <Panel title="Can't reach the core">
                      <ErrorLine error="The Monarch core is not reachable at the moment. Settings will load as soon as it reconnects." />
                    </Panel>
                  ) : sec.needsSettings ? (
                    <SettingsGate>
                      <Page />
                    </SettingsGate>
                  ) : (
                    <Page />
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
