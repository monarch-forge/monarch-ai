/**
 * CONFIG — settings, models, providers, accounts, permissions (route #/config/<tab>). UI-B.
 */
import type { ComponentType } from 'preact';
import type { LucideIcon } from 'lucide-preact';
import { UserRound, Cpu, KeyRound, Link2, ShieldCheck, Dna, AudioLines, RefreshCcw, FolderGit2 } from 'lucide-preact';
import { conn, health, navigate, settings } from '../lib/store.ts';
import { Panel, Tag, ErrorLine } from '../components/ui.tsx';
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

const TABS: { id: string; label: string; icon: LucideIcon; desc: string; page: ComponentType; needsSettings: boolean }[] = [
  { id: 'general', label: 'General', icon: UserRound, desc: 'Who you are, where you are, and how Monarch talks', page: GeneralSection, needsSettings: true },
  { id: 'models', label: 'Models', icon: Cpu, desc: 'Which models do the thinking', page: ModelsSection, needsSettings: true },
  { id: 'providers', label: 'Providers', icon: KeyRound, desc: 'Connect the services Monarch can use', page: ProvidersSection, needsSettings: false },
  { id: 'voice', label: 'Voice', icon: AudioLines, desc: 'Listening and speaking', page: VoiceSection, needsSettings: true },
  { id: 'accounts', label: 'Accounts', icon: Link2, desc: 'Google and Slack', page: AccountsSection, needsSettings: false },
  { id: 'projects', label: 'Projects', icon: FolderGit2, desc: 'Code projects and how to build and check their repos', page: ProjectsSection, needsSettings: false },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck, desc: 'What Monarch may do without asking', page: PermissionsSection, needsSettings: true },
  { id: 'evolution', label: 'Evolution', icon: Dna, desc: 'How Monarch grows new abilities', page: EvolutionSection, needsSettings: true },
  { id: 'sync', label: 'Sync', icon: RefreshCcw, desc: 'Keep your devices in step, end-to-end encrypted', page: SyncSection, needsSettings: true },
  { id: 'remote', label: 'Phone access', icon: Smartphone, desc: 'Use Monarch from your phone over Tailscale or your LAN', page: RemoteSection, needsSettings: false },
];

export default function ConfigPage(props: { params: string[] }) {
  const tab = TABS.find((t) => t.id === props.params[0]) ?? TABS[0];
  const Page = tab.page;
    const s = settings.value;

  return (
    <div class="h-full overflow-y-auto lg:overflow-hidden">
      <div class="lg:h-full flex flex-col lg:grid lg:grid-cols-[232px_minmax(0,1fr)] gap-2 lg:gap-6 px-4 lg:px-6 pt-4 lg:pt-6">
        <nav
          class="flex lg:flex-col gap-0.5 overflow-x-auto [scrollbar-width:none] lg:overflow-visible shrink-0 -mx-1 px-1 lg:mx-0 lg:px-0"
          aria-label="Settings sections"
        >
          <div class="hidden lg:block px-3 pb-3 text-[18px] font-semibold text-fg">Settings</div>
          {TABS.map((t, i) => {
            const Icon = t.icon;
            const on = t.id === tab.id;
            return (
              <a
                key={t.id}
                href={`#/config/${t.id}`}
                class={`relative flex items-center gap-2.5 shrink-0 rounded-[6px] px-3 py-2 text-[13.5px] transition-colors duration-150 ${
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
          <div class="max-w-[760px] flex flex-col gap-4 pb-10">
            <header class="pt-1 pb-1">
              <h1 class="text-[20px] font-semibold text-fg flex items-center gap-3">
                {tab.label}
                {conn.value !== 'open' && <Tag tone="warn">core offline</Tag>}
              </h1>
              <p class="text-[13px] text-fg-3 mt-0.5">{tab.desc}</p>
            </header>
            {conn.value !== 'open' && !s && tab.needsSettings ? (
              <Panel title="Can't reach the core">
                <ErrorLine error="The Monarch core is not reachable at the moment. Settings will load as soon as it reconnects." />
              </Panel>
            ) : tab.needsSettings ? (
              <SettingsGate>
                <Page key={tab.id} />
              </SettingsGate>
            ) : (
              <Page key={tab.id} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
