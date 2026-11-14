/**
 * CONFIG — settings, models, providers, accounts, permissions (route #/config/<tab>). UI-B.
 */
import type { ComponentType } from 'preact';
import type { LucideIcon } from 'lucide-preact';
import { UserRound, Cpu, KeyRound, Link2, ShieldCheck, Dna } from 'lucide-preact';
import { conn, health, navigate, settings } from '../lib/store.ts';
import { Panel, Tag, ErrorLine } from '../components/ui.tsx';
import { SettingsGate } from '../components/config/fields.tsx';
import { GeneralSection } from '../components/config/general.tsx';
import { ModelsSection } from '../components/config/models.tsx';
import { ProvidersSection } from '../components/config/providers.tsx';
import { AccountsSection } from '../components/config/accounts.tsx';
import { PermissionsSection } from '../components/config/permissions.tsx';
import { EvolutionSection } from '../components/config/evolution.tsx';

const TABS: { id: string; label: string; icon: LucideIcon; desc: string; page: ComponentType; needsSettings: boolean }[] = [
  { id: 'general', label: 'General', icon: UserRound, desc: 'Identity, location, persona, voice', page: GeneralSection, needsSettings: true },
  { id: 'models', label: 'Models', icon: Cpu, desc: 'Engine and default models', page: ModelsSection, needsSettings: true },
  { id: 'providers', label: 'Providers', icon: KeyRound, desc: 'API keys and logins', page: ProvidersSection, needsSettings: false },
  { id: 'accounts', label: 'Accounts', icon: Link2, desc: 'Google and Slack', page: AccountsSection, needsSettings: false },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck, desc: 'Approvals and folders', page: PermissionsSection, needsSettings: true },
  { id: 'evolution', label: 'Evolution', icon: Dna, desc: 'Self-extension and reflection', page: EvolutionSection, needsSettings: true },
];

export default function ConfigPage(props: { params: string[] }) {
  const tab = TABS.find((t) => t.id === props.params[0]) ?? TABS[0];
  const Page = tab.page;
  const idx = TABS.indexOf(tab);
  const s = settings.value;

  return (
    <div class="h-full p-3 grid gap-3 grid-cols-[220px_minmax(0,1fr)]">
      <Panel code="CFG.00" title="Config" noPad bodyClass="flex flex-col">
        <nav class="py-1.5 flex-1" aria-label="Config sections">
          {TABS.map((t, i) => {
            const Icon = t.icon;
            return (
              <a
                key={t.id}
                href={`#/config/${t.id}`}
                class="hud-row !items-start !py-2.5"
                data-active={t.id === tab.id ? 'true' : 'false'}
                aria-current={t.id === tab.id ? 'page' : undefined}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const n = TABS[(i + (e.key === 'ArrowDown' ? 1 : -1) + TABS.length) % TABS.length];
                    navigate(`config/${n.id}`);
                    requestAnimationFrame(() => document.querySelector<HTMLElement>(`a[href="#/config/${n.id}"]`)?.focus());
                  }
                }}
              >
                <Icon size={14} strokeWidth={1.5} class={`mt-0.5 shrink-0 ${t.id === tab.id ? 'text-fg' : 'text-fg-3'}`} />
                <span class="flex-1 min-w-0">
                  <span class={`block font-mono text-[11px] tracking-[0.14em] uppercase ${t.id === tab.id ? 'text-fg' : 'text-fg-2'}`}>{t.label}</span>
                  <span class="block text-[11px] text-fg-3 truncate mt-0.5">{t.desc}</span>
                </span>
                <span class="font-mono text-[10px] text-fg-3">{String(i + 1).padStart(2, '0')}</span>
              </a>
            );
          })}
        </nav>
        <div class="border-t border-line px-3.5 py-3 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 flex flex-col gap-1">
          <div class="flex justify-between">
            <span>core</span>
            <span class={conn.value === 'open' ? 'text-fg-2' : 'text-warning'}>{conn.value === 'open' ? 'online' : conn.value}</span>
          </div>
          {health.value && (
            <div class="flex justify-between">
              <span>version</span>
              <span class="text-fg-2">{health.value.version}</span>
            </div>
          )}
          {s && (
            <div class="flex justify-between">
              <span>engine</span>
              <span class="text-fg-2">{s.engine === 'pi' ? 'pi' : 'claude sdk'}</span>
            </div>
          )}
        </div>
      </Panel>

      <div class="min-h-0 overflow-y-auto pr-1">
        <div class="max-w-[960px] flex flex-col gap-3 pb-6">
          <div class="flex items-end gap-3 px-1 pt-1">
            <span class="font-mono text-[11px] text-fg-3">CFG.{String(idx + 1).padStart(2, '0')}</span>
            <h1 class="font-mono text-[13px] tracking-[0.2em] uppercase text-fg">{tab.label}</h1>
            <span class="text-[12px] text-fg-3">{tab.desc}</span>
            {conn.value !== 'open' && (
              <span class="ml-auto">
                <Tag tone="warn">core offline</Tag>
              </span>
            )}
          </div>
          {conn.value !== 'open' && !s && tab.needsSettings ? (
            <Panel code="ERR" title="Core unreachable">
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
  );
}
