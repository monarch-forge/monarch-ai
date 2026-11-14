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
  pi: { provider: 'anthropic', model: 'claude-sonnet-4-5', thinkingLevel: 'low', customModels: [], customBaseUrl: '' },
  permissions: { mode: 'ask' },
  coding: { defaultWorkspace: homedir(), workspaces: [] },
  memory: { vaultDir: paths.vault },
  evolution: { enabled: true, autoEnable: true, reflect: 'off', deferTools: true },
};

const store = dataStore<Settings>('settings', DEFAULT_SETTINGS);

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
