/** Settings store. OWNED BY THE ORCHESTRATOR. */
import { homedir } from 'node:os';
import type { Settings } from '@monarch/shared';
import { dataStore, deepMerge, changed, paths } from './kernel.ts';

export const DEFAULT_SETTINGS: Settings = {
  user: { name: '', honorific: 'sir', location: null, units: 'metric' },
  assistant: {
    name: 'Monarch',
    persona: '',
    voice: { speak: false, listen: false, rate: 1 },
  },
  engine: 'claude-sdk',
  claudeSdk: { model: 'sonnet', executablePath: '', useSubscription: true, effort: 'medium' },
  pi: { provider: 'anthropic', model: 'claude-sonnet-4-5', thinkingLevel: 'low', customProviders: [] },
  permissions: { mode: 'ask' },
  coding: { defaultWorkspace: homedir(), workspaces: [] },
  memory: { vaultDir: paths.vault },
  evolution: { enabled: true, autoEnable: true, reflect: 'off', deferTools: true },
};

const store = dataStore<Settings>('settings', DEFAULT_SETTINGS);
migrateCustomProvider();

/** pre-0.3.2: one implicit "custom" provider (pi.customModels + pi.customBaseUrl) → pi.customProviders[0] */
function migrateCustomProvider(): void {
  const pi = store.get().pi as Settings['pi'];
  if (!('customModels' in pi) && !('customBaseUrl' in pi)) return;
  const models = pi.customModels ?? [];
  const baseUrl = (pi.customBaseUrl ?? '').trim();
  if (!Array.isArray(pi.customProviders)) pi.customProviders = [];
  if ((models.length || baseUrl) && !pi.customProviders.some((p) => p.id === 'custom')) {
    // keep the id "custom" so existing sessions and the stored API key (secrets.apiKeys.custom) keep working
    pi.customProviders.unshift({ id: 'custom', name: 'Custom', baseUrl, models });
  }
  delete pi.customModels;
  delete pi.customBaseUrl;
  store.save();
}

export function getSettings(): Settings {
  return store.get();
}

const listeners = new Set<(s: Settings) => void>();

/** deep-merge a partial patch (arrays replace) and persist; notifies listeners + broadcasts data.changed('settings') */
export function updateSettings(patch: Partial<Settings> | Record<string, unknown>): Settings {
  const next = store.set(deepMerge(store.get() as any, patch as any) as Settings);
  for (const l of listeners) {
    try {
      l(next);
    } catch (e) {
      console.error('settings listener failed', e);
    }
  }
  changed('settings');
  return next;
}

/** subscribe to settings changes */
export function onSettingsChanged(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
