/**
 * Provider auth & model catalog for the REST surface:
 *  - 'claude-sdk'  Claude Code (subscription login owned by the CLI, or a stored Anthropic API key)
 *  - every pi-ai provider (API key / OAuth / env)
 *  - 'custom'      OpenAI-compatible endpoints from settings.pi.customModels
 * Secrets never leave the core; only status metadata is returned.
 */
import type { ModelInfo, OAuthFlowState, ProviderAuthKind, ProviderStatus } from '@monarch/shared';
import type { Api, AuthInteraction, AuthPrompt, Model } from '@earendil-works/pi-ai';
import { activity, bus, changed, HttpError, newId, secrets } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { claudeModelCount, claudeModels, claudeStatus, invalidateClaudeStatus } from './claude.ts';
import { CUSTOM_PROVIDER, customModelToPi, piModels } from './pi-models.ts';
import { errorText } from './toolset.ts';

export const CLAUDE_SDK = 'claude-sdk';
const latency = new Map<string, number>();

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/* ─────────────── status ─────────────── */

async function claudeProviderStatus(fresh = false): Promise<ProviderStatus> {
  const s = getSettings().claudeSdk;
  const st = await claudeStatus(fresh);
  const storedKey = !!secrets.get().apiKeys['anthropic'];
  const envKey = !!process.env.ANTHROPIC_API_KEY;
  const base: ProviderStatus = {
    id: CLAUDE_SDK,
    name: 'Claude (Claude Code)',
    engine: 'claude-sdk',
    authKinds: ['subscription', 'api-key'],
    configured: false,
    modelCount: claudeModelCount(),
    latencyMs: latency.get(CLAUDE_SDK),
  };
  if (!st.installed) return { ...base, source: 'none', error: st.error };
  if (s.useSubscription) {
    return st.loggedIn
      ? { ...base, configured: true, source: 'claude-code', account: st.account }
      : { ...base, source: 'none', error: st.error };
  }
  if (storedKey) return { ...base, configured: true, source: 'stored-key' };
  if (envKey) return { ...base, configured: true, source: 'env' };
  return { ...base, source: 'none', error: 'API-key mode selected but no Anthropic API key is stored.' };
}

function customStatus(): ProviderStatus {
  const list = getSettings().pi.customModels ?? [];
  return {
    id: CUSTOM_PROVIDER,
    name: 'Custom (OpenAI-compatible)',
    engine: 'pi',
    authKinds: ['local', 'api-key'],
    configured: list.length > 0,
    source: secrets.get().apiKeys[CUSTOM_PROVIDER] ? 'stored-key' : undefined,
    modelCount: list.length,
    latencyMs: latency.get(CUSTOM_PROVIDER),
  };
}

async function piProviderStatus(id: string): Promise<ProviderStatus> {
  if (id === CUSTOM_PROVIDER) return customStatus();
  const models = piModels();
  const p = models.getProvider(id);
  if (!p) throw new HttpError(404, `Unknown provider: ${id}`);
  const authKinds: ProviderAuthKind[] = [];
  if (p.auth.apiKey) authKinds.push('api-key');
  if (p.auth.oauth) authKinds.push('oauth');
  const base: ProviderStatus = {
    id,
    name: p.name,
    engine: 'pi',
    authKinds,
    configured: false,
    modelCount: safeCount(() => p.getModels().length),
    latencyMs: latency.get(id),
  };
  try {
    const check = await withTimeout(models.checkAuth(id), 4000, 'auth check');
    if (!check) return { ...base, source: 'none' };
    if (check.type === 'oauth') {
      const c = secrets.get().piOAuth[id] as Record<string, unknown> | undefined;
      const account = typeof c?.email === 'string' ? c.email : typeof c?.accountId === 'string' ? c.accountId : undefined;
      return { ...base, configured: true, source: 'oauth', account: account ?? p.auth.oauth?.name };
    }
    if (secrets.get().apiKeys[id]) return { ...base, configured: true, source: 'stored-key' };
    return { ...base, configured: true, source: 'env', account: check.source };
  } catch (e) {
    return { ...base, source: 'none', error: errorText(e) };
  }
}

function safeCount(fn: () => number): number {
  try {
    return fn();
  } catch {
    return 0;
  }
}

export async function providerStatus(id: string, fresh = false): Promise<ProviderStatus> {
  if (id === CLAUDE_SDK) return claudeProviderStatus(fresh);
  return piProviderStatus(id);
}

export async function listProviders(): Promise<ProviderStatus[]> {
  const models = piModels();
  const ids = models
    .getProviders()
    .map((p) => p.id)
    .filter((id) => id !== CUSTOM_PROVIDER && id !== 'faux');
  const [claude, ...pis] = await Promise.all([
    claudeProviderStatus().catch(
      (e): ProviderStatus => ({
        id: CLAUDE_SDK,
        name: 'Claude (Claude Code)',
        engine: 'claude-sdk',
        authKinds: ['subscription', 'api-key'],
        configured: false,
        modelCount: 0,
        error: errorText(e),
      }),
    ),
    ...ids.map((id) => piProviderStatus(id)),
  ]);
  pis.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
  return [claude, ...pis, customStatus()];
}

/* ─────────────── keys ─────────────── */

/** claude-sdk's API-key mode uses the Anthropic key */
const keySlot = (id: string) => (id === CLAUDE_SDK ? 'anthropic' : id);

function assertKnown(id: string): void {
  if (id === CLAUDE_SDK || id === CUSTOM_PROVIDER) return;
  if (!piModels().getProvider(id)) throw new HttpError(404, `Unknown provider: ${id}`);
}

export async function setProviderKey(id: string, apiKey: string): Promise<ProviderStatus> {
  assertKnown(id);
  const key = (apiKey ?? '').trim();
  if (!key) throw new HttpError(400, 'apiKey is required');
  secrets.update((s) => {
    s.apiKeys[keySlot(id)] = key;
  });
  secrets.flush();
  if (id === CLAUDE_SDK) invalidateClaudeStatus();
  latency.delete(id);
  changed('providers');
  activity('SYS', `API key stored for ${id}`);
  return providerStatus(id);
}

export async function deleteProviderKey(id: string): Promise<ProviderStatus> {
  assertKnown(id);
  secrets.update((s) => {
    delete s.apiKeys[keySlot(id)];
  });
  secrets.flush();
  latency.delete(id);
  changed('providers');
  return providerStatus(id);
}

/* ─────────────── ping ─────────────── */

function pingModel(id: string): Model<Api> | undefined {
  const models = piModels();
  if (id === CUSTOM_PROVIDER) {
    const first = getSettings().pi.customModels?.[0];
    return first ? customModelToPi(first) : undefined;
  }
  const s = getSettings().pi;
  if (s.provider === id) {
    const m = models.getModel(id, s.model);
    if (m) return m;
  }
  const list = [...models.getModels(id)].filter((m) => m.input.includes('text'));
  list.sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output));
  return list.find((m) => !m.reasoning) ?? list[0];
}

export async function pingProvider(id: string): Promise<ProviderStatus> {
  if (id === CLAUDE_SDK) {
    const t0 = Date.now();
    const st = await providerStatus(id, true);
    latency.set(id, Date.now() - t0);
    changed('providers');
    return { ...st, latencyMs: latency.get(id) };
  }
  const st = await providerStatus(id);
  if (!st.configured) return { ...st, error: st.error ?? 'Not configured' };
  const model = pingModel(id);
  if (!model) return { ...st, error: 'No model available to ping' };
  const t0 = Date.now();
  try {
    const res = await piModels().completeSimple(
      model,
      { messages: [{ role: 'user', content: 'Reply with the single word: OK', timestamp: Date.now() }] },
      { maxTokens: 16, signal: AbortSignal.timeout(30_000) },
    );
    const ms = Date.now() - t0;
    if (res.stopReason === 'error' || res.stopReason === 'aborted') {
      return { ...st, error: res.errorMessage || res.stopReason };
    }
    latency.set(id, ms);
    changed('providers');
    return { ...st, latencyMs: ms, error: undefined };
  } catch (e) {
    return { ...st, error: errorText(e) };
  }
}

/* ─────────────── OAuth flows ─────────────── */

interface Flow {
  state: OAuthFlowState;
  abort: AbortController;
  pending?: { resolve: (v: string) => void; reject: (e: Error) => void };
  timer?: NodeJS.Timeout;
}
const flows = new Map<string, Flow>();

function publish(flow: Flow, patch: Partial<OAuthFlowState>): OAuthFlowState {
  flow.state = { ...flow.state, ...patch };
  bus.broadcast({ type: 'oauth.progress', flow: flow.state });
  if (flow.state.status === 'done' || flow.state.status === 'error') {
    if (flow.timer) clearInterval(flow.timer);
    setTimeout(() => flows.delete(flow.state.flowId), 10 * 60_000).unref?.();
  }
  return flow.state;
}

function deviceId(): string {
  const s = secrets.get() as Record<string, unknown>;
  if (typeof s.deviceId !== 'string') {
    secrets.update((x) => {
      (x as Record<string, unknown>).deviceId = newId();
    });
  }
  return (secrets.get() as Record<string, unknown>).deviceId as string;
}

export function startLogin(id: string): OAuthFlowState {
  const flowId = newId();
  const flow: Flow = { state: { flowId, provider: id, status: 'starting' }, abort: new AbortController() };
  flows.set(flowId, flow);

  if (id === CLAUDE_SDK) {
    // Claude Code owns its login; we only detect it.
    publish(flow, {
      status: 'awaiting-browser',
      instructions:
        'Open a terminal and run `claude auth login` to sign in with your Claude Pro/Max subscription (or `claude setup-token` for a long-lived token). Monarch detects the login automatically.',
    });
    const started = Date.now();
    flow.timer = setInterval(async () => {
      if (flow.abort.signal.aborted || Date.now() - started > 10 * 60_000) {
        clearInterval(flow.timer);
        if (flow.state.status !== 'done') publish(flow, { status: 'error', error: flow.abort.signal.aborted ? 'cancelled' : 'timed out' });
        return;
      }
      const st = await claudeStatus(true).catch(() => null);
      if (st?.loggedIn) {
        publish(flow, { status: 'done', message: `Signed in${st.account ? ` as ${st.account}` : ''}` });
        changed('providers');
      }
    }, 3000);
    flow.timer.unref?.();
    return flow.state;
  }

  const models = piModels();
  const p = models.getProvider(id);
  if (!p) {
    flows.delete(flowId);
    throw new HttpError(404, `Unknown provider: ${id}`);
  }
  if (!p.auth.oauth) {
    flows.delete(flowId);
    throw new HttpError(400, `${p.name} does not support sign-in; add an API key instead.`);
  }

  const interaction: AuthInteraction = {
    signal: flow.abort.signal,
    notify(ev) {
      if (ev.type === 'auth_url') publish(flow, { status: 'awaiting-browser', url: ev.url, instructions: ev.instructions ?? 'Open the link to sign in.' });
      else if (ev.type === 'device_code')
        publish(flow, {
          status: 'awaiting-browser',
          url: ev.verificationUri,
          userCode: ev.userCode,
          instructions: `Open the link and enter the code ${ev.userCode}.`,
        });
      else if (ev.type === 'progress') publish(flow, { status: 'working', message: ev.message });
      else if (ev.type === 'info') publish(flow, { message: ev.message, url: flow.state.url ?? ev.links?.[0]?.url });
    },
    prompt(pr: AuthPrompt): Promise<string> {
      if (pr.type === 'select') {
        // no select UI in OAuthFlowState: take the first (default) option
        publish(flow, { message: `${pr.message} → ${pr.options[0]?.label ?? ''}` });
        return Promise.resolve(pr.options[0]?.id ?? '');
      }
      return new Promise<string>((resolve, reject) => {
        const prev = { url: flow.state.url, instructions: flow.state.instructions };
        flow.pending = {
          resolve: (v) => {
            flow.pending = undefined;
            resolve(v);
          },
          reject: (e) => {
            flow.pending = undefined;
            reject(e);
          },
        };
        publish(flow, { status: 'awaiting-code', message: pr.message, ...prev });
        pr.signal?.addEventListener(
          'abort',
          () => {
            // the local callback server won the race
            if (flow.pending) {
              flow.pending.reject(new Error('superseded'));
              publish(flow, { status: 'working', message: 'Received authorization…' });
            }
          },
          { once: true },
        );
        flow.abort.signal.addEventListener('abort', () => flow.pending?.reject(new Error('cancelled')), { once: true });
      });
    },
  };

  void (async () => {
    try {
      await models.login(id, 'oauth', interaction, { agentName: 'Monarch', getDeviceId: deviceId });
      latency.delete(id);
      publish(flow, { status: 'done', message: `Signed in to ${p.name}` });
      activity('SYS', `Signed in to ${p.name}`);
      changed('providers');
    } catch (e) {
      publish(flow, { status: 'error', error: flow.abort.signal.aborted ? 'cancelled' : errorText(e) });
    }
  })();
  return flow.state;
}

export function getFlow(flowId: string): OAuthFlowState | undefined {
  return flows.get(flowId)?.state;
}

export function submitOAuthCode(flowId: string, code: string): OAuthFlowState | undefined {
  const flow = flows.get(flowId);
  if (!flow) return undefined;
  if (!flow.pending) throw new HttpError(409, 'This sign-in is not waiting for a code.');
  flow.pending.resolve(String(code ?? '').trim());
  return publish(flow, { status: 'working', message: 'Verifying…' });
}

export function cancelOAuthFlow(flowId: string): boolean {
  const flow = flows.get(flowId);
  if (!flow) return false;
  flow.abort.abort();
  flow.pending?.reject(new Error('cancelled'));
  if (flow.state.status !== 'done' && flow.state.status !== 'error') publish(flow, { status: 'error', error: 'cancelled' });
  return true;
}

export async function logoutProvider(id: string): Promise<ProviderStatus> {
  if (id === CLAUDE_SDK) {
    throw new HttpError(400, 'Claude Code owns this login. Run `claude auth logout` in a terminal to sign out.');
  }
  assertKnown(id);
  secrets.update((s) => {
    delete s.piOAuth[id];
  });
  secrets.flush();
  latency.delete(id);
  changed('providers');
  activity('SYS', `Signed out of ${id}`);
  return providerStatus(id);
}

/* ─────────────── models ─────────────── */

export function piModelInfo(m: Model<Api>): ModelInfo {
  return {
    id: m.id,
    name: m.name || m.id,
    provider: m.provider,
    engine: 'pi',
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    reasoning: m.reasoning,
    input: m.input.filter((x): x is 'text' | 'image' => x === 'text' || x === 'image'),
    cost: { input: m.cost.input, output: m.cost.output },
  };
}

export async function listModels(engine?: string, provider?: string): Promise<ModelInfo[]> {
  if (provider === CLAUDE_SDK || (engine === 'claude-sdk' && !provider)) return claudeModels({ wait: true });
  const models = piModels();
  if (provider) {
    if (provider !== CUSTOM_PROVIDER && !models.getProvider(provider)) throw new HttpError(404, `Unknown provider: ${provider}`);
    return models.getModels(provider).map(piModelInfo);
  }
  const pi = models.getModels(getSettings().pi.provider).map(piModelInfo);
  if (engine === 'pi') return pi;
  return [...(await claudeModels()), ...pi];
}
