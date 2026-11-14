/**
 * pi-ai runtime: one `Models` collection with every built-in provider, a credential store backed by
 * Monarch's secrets.json, and one provider per entry of settings.pi.customProviders
 * (OpenAI-compatible endpoints: OpenAI-style clouds, OpenRouter, Ollama, LM Studio, vLLM…).
 *
 * Credential precedence per provider (pi-ai: a stored credential owns its provider):
 *   secrets.piOAuth[id] (OAuth, refreshed + persisted by pi-ai under the store lock)
 *   → secrets.apiKeys[id] (stored API key)
 *   → provider env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) resolved by pi-ai itself.
 */
import type { CustomModel, CustomProvider } from '@monarch/shared';
import {
  createProvider,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type MutableModels,
  type OAuthCredential,
  type Api,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { secrets } from '../kernel.ts';
import { getSettings, onSettingsChanged } from '../settings.ts';


type ProviderEnvMap = Record<string, Record<string, string>>;

function envStore(): ProviderEnvMap {
  const s = secrets.get() as Record<string, unknown>;
  if (!s.piKeyEnv || typeof s.piKeyEnv !== 'object') s.piKeyEnv = {};
  return s.piKeyEnv as ProviderEnvMap;
}

/** CredentialStore over secrets.json (writes are flushed synchronously so rotated refresh tokens are never lost) */
class SecretsCredentialStore implements CredentialStore {
  private chains = new Map<string, Promise<unknown>>();

  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  private readNow(id: string): Credential | undefined {
    const s = secrets.get();
    const oauth = s.piOAuth?.[id] as OAuthCredential | undefined;
    if (oauth && typeof oauth === 'object' && typeof oauth.access === 'string') return { ...oauth, type: 'oauth' };
    const key = s.apiKeys?.[id];
    const env = envStore()[id];
    if (key || env) return { type: 'api_key', key: key || undefined, env };
    return undefined;
  }

  async read(id: string): Promise<Credential | undefined> {
    return this.readNow(id);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const s = secrets.get();
    const ids = new Set([...Object.keys(s.piOAuth ?? {}), ...Object.keys(s.apiKeys ?? {}), ...Object.keys(envStore())]);
    const out: CredentialInfo[] = [];
    for (const id of ids) {
      const c = this.readNow(id);
      if (c) out.push({ providerId: id, type: c.type });
    }
    return out;
  }

  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.enqueue(id, async () => {
      const next = await fn(this.readNow(id));
      if (next === undefined) return this.readNow(id);
      secrets.update((s) => {
        if (next.type === 'oauth') {
          s.piOAuth[id] = { ...next };
        } else {
          if (next.key) s.apiKeys[id] = next.key;
          const env = envStore();
          if (next.env && Object.keys(next.env).length) env[id] = { ...(next.env as Record<string, string>) };
        }
      });
      secrets.flush();
      return this.readNow(id);
    });
  }

  delete(id: string): Promise<void> {
    return this.enqueue(id, async () => {
      secrets.update((s) => {
        if (s.piOAuth?.[id]) delete s.piOAuth[id];
        else {
          delete s.apiKeys[id];
          delete envStore()[id];
        }
      });
      secrets.flush();
    });
  }
}

export const credentialStore = new SecretsCredentialStore();

let models: MutableModels | null = null;

/* ─────────────── custom OpenAI-compatible providers ─────────────── */

/** user-added OpenAI-compatible providers (Settings.pi.customProviders) */
export function customProviders(): CustomProvider[] {
  return getSettings().pi.customProviders ?? [];
}

export function getCustomProvider(id: string): CustomProvider | undefined {
  return customProviders().find((p) => p.id === id);
}

export function isCustomProvider(id: string): boolean {
  return !!getCustomProvider(id);
}

/** a model's endpoint: its own base URL, else its provider's */
export function customBaseUrl(prov: Pick<CustomProvider, 'baseUrl'>, m?: Pick<CustomModel, 'baseUrl'>): string {
  return (m?.baseUrl?.trim() || prov.baseUrl?.trim() || '').replace(/\/+$/, '');
}

/** a provider's usable models (id + resolvable base URL) */
export function usableCustomModels(prov: CustomProvider): CustomModel[] {
  return (prov.models ?? []).filter((m) => m.id?.trim() && customBaseUrl(prov, m));
}

export function customModelToPi(prov: CustomProvider, m: CustomModel): Model<'openai-completions'> {
  return {
    id: m.id,
    name: m.name || m.id,
    api: 'openai-completions',
    provider: prov.id,
    baseUrl: customBaseUrl(prov, m),
    reasoning: !!m.reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow || 32768,
    maxTokens: m.maxTokens || 8192,
    headers: m.apiKey ? { Authorization: `Bearer ${m.apiKey}` } : undefined,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
    },
  };
}

function buildCustomProvider(prov: CustomProvider) {
  return createProvider<'openai-completions'>({
    id: prov.id,
    name: prov.name || prov.id,
    // keyless local servers: always "configured"; the provider's stored key (secrets.apiKeys[id]) is sent as Bearer
    auth: {
      apiKey: {
        name: 'API key (optional for local servers)',
        resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key || 'local' }, source: credential?.key ? 'stored credential' : 'local' }),
      },
    },
    models: usableCustomModels(prov).map((m) => customModelToPi(prov, m)),
    api: openAICompletionsApi(),
  });
}

/** custom provider ids currently registered in the Models collection */
const registeredCustom = new Set<string>();

function syncCustomProviders(m: MutableModels): void {
  const want = customProviders();
  const ids = new Set(want.map((p) => p.id));
  for (const id of [...registeredCustom]) {
    if (ids.has(id)) continue;
    try {
      m.deleteProvider(id);
    } catch {
      /* already gone */
    }
    registeredCustom.delete(id);
  }
  for (const p of want) {
    try {
      m.setProvider(buildCustomProvider(p));
      registeredCustom.add(p.id);
    } catch (e) {
      console.error(`[pi] custom provider "${p.id}" failed`, e);
    }
  }
}

/** the shared pi-ai Models collection (lazy: importing every catalog costs ~0.5s once) */
export function piModels(): MutableModels {
  if (models) return models;
  models = builtinModels({
    credentials: credentialStore,
    identity: { attribution: null, userAgent: 'short' },
  });
  syncCustomProviders(models);
  onSettingsChanged(() => {
    if (models) syncCustomProviders(models);
  });
  return models;
}

/**
 * Resolve the pi model for a session. `modelSpec` may be a bare model id (looked up under `provider`)
 * or "<provider>/<model-id>" when the prefix is a registered provider.
 */
export function resolvePiModel(provider: string, modelSpec: string): { provider: string; model: Model<Api> | undefined } {
  const m = piModels();
  const slash = modelSpec.indexOf('/');
  if (slash > 0) {
    const p = modelSpec.slice(0, slash);
    const id = modelSpec.slice(slash + 1);
    if (m.getProvider(p)) {
      const hit = m.getModel(p, id);
      if (hit) return { provider: p, model: hit };
    }
  }
  return { provider, model: m.getModel(provider, modelSpec) };
}
