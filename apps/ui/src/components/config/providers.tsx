/** Config → Providers: status table, ping, API keys, OAuth login/logout. */
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { CustomModel, OAuthFlowState, ProviderStatus } from '@monarch/shared';
import { ChevronRight, Activity, KeyRound, LogIn, LogOut, RefreshCw, Link2, Search, Plus, Check, Trash2 } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { oauthFlows, settings, toast, useResource } from '../../lib/store.ts';
import { Panel, Tag, Spinner, ErrorLine, Empty } from '../ui.tsx';
import { INPUT, Kbd } from './fields.tsx';
import { OAuthFlowView } from './oauth-flow.tsx';

const BTN = 'btn btn-xs rounded-[2px] font-mono font-normal uppercase tracking-wider text-[10px]';
const BTN_OUT = `${BTN} btn-outline border-line text-fg-2 hover:bg-subtle hover:border-fg-3 hover:text-fg`;

export function ProvidersSection() {
  const res = useResource<ProviderStatus[]>('/providers', ['providers']);
  const [open, setOpen] = useState<string | null>(null);
  const [pinging, setPinging] = useState<Record<string, boolean>>({});
  const [engineFilter, setEngineFilter] = useState<'all' | 'claude-sdk' | 'pi'>('all');

  const replace = (p: ProviderStatus) => res.setData((res.data ?? []).map((x) => (x.id === p.id ? p : x)));

  const ping = async (id: string) => {
    setPinging((s) => ({ ...s, [id]: true }));
    try {
      const p = await api.post<ProviderStatus>(`/providers/${encodeURIComponent(id)}/ping`, {});
      replace(p);
      if (p.error) toast(`${p.name}: ${p.error}`, 'warn');
    } catch (e: any) {
      toast(`Ping failed: ${e?.message ?? e}`, 'error');
    } finally {
      setPinging((s) => ({ ...s, [id]: false }));
    }
  };

  const [adding, setAdding] = useState(false);
  const addCustom = async () => {
    setAdding(true);
    try {
      const p = await api.post<ProviderStatus>('/custom-providers', { name: 'Custom provider', baseUrl: '' });
      await res.reload();
      setEngineFilter('all');
      setOpen(p.id);
      window.setTimeout(() => document.getElementById(`prov-${p.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120);
    } catch (e: any) {
      toast(`Could not add provider: ${e?.message ?? e}`, 'error');
    } finally {
      setAdding(false);
    }
  };

  // connected providers first, then alphabetical by name
  const list = (res.data ?? [])
    .filter((p) => engineFilter === 'all' || p.engine === engineFilter)
    .slice()
    .sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const configured = (res.data ?? []).filter((p) => p.configured).length;

  return (
    <Panel
      code="CFG.31"
      title="Providers"
      noPad
      right={
        <>
          {res.data && (
            <Tag tone={configured ? 'ok' : 'warn'}>
              {configured}/{res.data.length} ready
            </Tag>
          )}
          <select
            class="select select-xs bg-[#121213] border-line rounded-[2px] font-mono text-[10px] uppercase w-28"
            value={engineFilter}
            onChange={(e) => setEngineFilter((e.target as HTMLSelectElement).value as typeof engineFilter)}
            aria-label="Filter by engine"
          >
            <option value="all">all</option>
            <option value="claude-sdk">claude sdk</option>
            <option value="pi">pi</option>
          </select>
          <button class={BTN_OUT} onClick={() => void addCustom()} disabled={adding} title="Add an OpenAI-compatible provider (OpenAI, OpenRouter, Together, Groq, vLLM, Ollama, LM Studio…)">
            {adding ? <span class="loading loading-spinner loading-xs" /> : <Plus size={11} />} Custom provider
          </button>
          <button class="text-fg-3 hover:text-fg-2" title="Refresh" onClick={() => void res.reload()}>
            <RefreshCw size={12} strokeWidth={1.5} class={res.loading ? 'animate-spin' : ''} />
          </button>
        </>
      }
    >
      {res.loading && !res.data ? (
        <div class="flex justify-center py-8">
          <Spinner />
        </div>
      ) : res.error && !res.data ? (
        <div class="p-4">
          <ErrorLine error={res.error} />
        </div>
      ) : list.length === 0 ? (
        <Empty>No providers</Empty>
      ) : (
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr class="border-line font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
                <th class="w-6" />
                <th>Provider</th>
                <th>Engine</th>
                <th>Status</th>
                <th>Account / source</th>
                <th class="text-right">Models</th>
                <th class="text-right">Latency</th>
                <th class="w-20" />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const isOpen = open === p.id;
                return (
                  <Fragment key={p.id}>
                    <tr id={`prov-${p.id}`} class={`border-line cursor-pointer hover:bg-white/[0.02] ${isOpen ? 'bg-subtle/50' : ''}`} onClick={() => setOpen(isOpen ? null : p.id)}>
                      <td>
                        <ChevronRight size={12} class={`text-fg-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                      </td>
                      <td>
                        <div class="text-[13px] text-fg">{p.name}</div>
                        <div class="font-mono text-[10px] text-fg-3">
                          {p.id}
                          {p.custom && <span class="text-red/80"> · custom</span>}
                        </div>
                      </td>
                      <td class="font-mono text-[11px] text-fg-2 uppercase">{p.engine === 'pi' ? 'pi' : 'claude'}</td>
                      <td>
                        {p.error ? (
                          <Tag tone="red" title={p.error}>
                            error
                          </Tag>
                        ) : p.configured ? (
                          <Tag tone="ok">ready</Tag>
                        ) : (
                          <Tag>not set</Tag>
                        )}
                      </td>
                      <td class="text-[12px]">
                        {p.account && <div class="text-fg-2 truncate max-w-[220px]">{p.account}</div>}
                        <div class="font-mono text-[10px] text-fg-3 uppercase">{p.source && p.source !== 'none' ? p.source : p.authKinds.join(' · ')}</div>
                      </td>
                      <td class="text-right font-mono text-[12px] text-fg-2 tabular-nums">{p.modelCount}</td>
                      <td class="text-right font-mono text-[12px] tabular-nums">
                        {p.latencyMs !== undefined ? <span class={p.latencyMs > 2000 ? 'text-warning' : 'text-fg-2'}>{Math.round(p.latencyMs)}ms</span> : <span class="text-fg-3">—</span>}
                      </td>
                      <td class="text-right" onClick={(e) => e.stopPropagation()}>
                        <button class={BTN_OUT} disabled={pinging[p.id] || !p.configured} onClick={() => void ping(p.id)} title={p.configured ? 'Measure round-trip' : 'Configure first'}>
                          {pinging[p.id] ? <span class="loading loading-spinner loading-xs" /> : <Activity size={11} />} Ping
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr class="border-line bg-subtle/30">
                        <td />
                        <td colSpan={7} class="py-3">
                          <ProviderDetail
                            p={p}
                            onChanged={(np) => (np ? replace(np) : void res.reload())}
                            onRemoved={() => {
                              setOpen(null);
                              void res.reload();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ProviderDetail(props: { p: ProviderStatus; onChanged: (p?: ProviderStatus) => void; onRemoved: () => void }) {
  const { p } = props;
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flow, setFlow] = useState<OAuthFlowState | null>(null);

  const run = async <T,>(tag: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(tag);
    try {
      const r = await fn();
      if (ok) toast(ok, 'success');
      return r;
    } catch (e: any) {
      toast(`${p.name}: ${e?.message ?? e}`, 'error');
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const saveKey = async () => {
    if (!key.trim()) return;
    const r = await run('key', () => api.put<ProviderStatus>(`/providers/${encodeURIComponent(p.id)}/key`, { apiKey: key.trim() }), `${p.name} key saved`);
    if (r) {
      setKey('');
      props.onChanged(r);
    }
  };
  const clearKey = async () => {
    const r = await run('clear', () => api.del<ProviderStatus>(`/providers/${encodeURIComponent(p.id)}/key`), `${p.name} key removed`);
    if (r) props.onChanged(r);
  };
  const login = async () => {
    const f = await run('login', () => api.post<OAuthFlowState>(`/providers/${encodeURIComponent(p.id)}/login`, {}));
    if (f) {
      oauthFlows.value = { ...oauthFlows.value, [f.flowId]: oauthFlows.value[f.flowId] ?? f };
      setFlow(f);
    }
  };
  const logout = async () => {
    const r = await run('logout', () => api.del<ProviderStatus>(`/providers/${encodeURIComponent(p.id)}/login`), `Logged out of ${p.name}`);
    if (r) props.onChanged(r);
  };

  const hasKey = p.authKinds.includes('api-key');
  const hasOAuth = p.authKinds.includes('oauth');

  return (
    <div class="flex flex-col gap-4 max-w-[720px]">
      {p.error && <div class="font-mono text-[11.5px] text-red">{p.error}</div>}

      {p.authKinds.includes('subscription') && (
        <div class="text-[12.5px] text-fg-2 leading-relaxed">
          Uses your Claude Code login{p.account ? <> ({p.account})</> : null}. {p.configured ? 'Signed in.' : <>Run <Kbd>claude auth login</Kbd> in a terminal to sign in.</>}
        </div>
      )}
      {p.custom && <CustomProviderEditor p={p} onChanged={props.onChanged} />}

      {hasKey && (
        <div>
          <div class="hud-label text-[10px] mb-1.5 flex items-center gap-1.5">
            <KeyRound size={11} /> API key {p.source === 'env' && <span class="normal-case tracking-normal text-fg-3">· currently from environment</span>}
          </div>
          <div class="flex gap-2">
            <input
              class={`${INPUT} font-mono`}
              type="password"
              autoComplete="off"
              placeholder={p.source === 'stored-key' ? '•••••••• stored — paste to replace' : 'Paste API key'}
              value={key}
              onInput={(e) => setKey((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
            />
            <button class={`${BTN} btn-primary h-8`} disabled={!key.trim() || busy === 'key'} onClick={() => void saveKey()}>
              {busy === 'key' && <span class="loading loading-spinner loading-xs" />}Save
            </button>
            {p.source === 'stored-key' && (
              <button class={`${BTN_OUT} h-8`} disabled={busy === 'clear'} onClick={() => void clearKey()}>
                Clear
              </button>
            )}
          </div>
          <div class="text-[11px] text-fg-3 mt-1">Stored encrypted by the core; never sent back to the UI.</div>
        </div>
      )}

      {hasOAuth && (
        <div>
          <div class="hud-label text-[10px] mb-1.5">Account login</div>
          <div class="flex gap-2 items-center">
            {p.source === 'oauth' ? (
              <>
                <span class="text-[12.5px] text-fg-2">Logged in{p.account ? ` as ${p.account}` : ''}.</span>
                <button class={BTN_OUT} disabled={busy === 'logout'} onClick={() => void logout()}>
                  <LogOut size={11} /> Logout
                </button>
                <button class={BTN_OUT} disabled={busy === 'login' || !!flow} onClick={() => void login()}>
                  Re-login
                </button>
              </>
            ) : (
              <button class={`${BTN} btn-primary`} disabled={busy === 'login' || (!!flow && flow.status !== 'error')} onClick={() => void login()}>
                {busy === 'login' ? <span class="loading loading-spinner loading-xs" /> : <LogIn size={11} />} Login with {p.name}
              </button>
            )}
          </div>
          {flow && (
            <div class="mt-3">
              <OAuthFlowView
                initial={flow}
                onFinished={(f) => {
                  if (f.status === 'done') {
                    toast(`${p.name} connected`, 'success');
                    props.onChanged();
                    window.setTimeout(() => setFlow(null), 2500);
                  }
                }}
                onDismiss={() => setFlow(null)}
              />
            </div>
          )}
        </div>
      )}

      {p.custom && <RemoveCustom p={p} onRemoved={props.onRemoved} />}
    </div>
  );
}

function RemoveCustom(props: { p: ProviderStatus; onRemoved: () => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/custom-providers/${encodeURIComponent(props.p.id)}`);
      toast(`${props.p.name} removed`, 'success');
      props.onRemoved();
    } catch (e: any) {
      toast(`Remove failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="flex items-center gap-2 pt-1 border-t border-line/60">
      {armed ? (
        <>
          <span class="text-[12px] text-fg-2">Remove {props.p.name}, its models and its stored key?</span>
          <button class={`${BTN} btn-error h-7`} disabled={busy} onClick={() => void remove()}>
            {busy && <span class="loading loading-spinner loading-xs" />}Remove
          </button>
          <button class={`${BTN_OUT} h-7`} onClick={() => setArmed(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button class={`${BTN_OUT} h-7 hover:!text-red hover:!border-red/60`} onClick={() => setArmed(true)}>
          <Trash2 size={11} /> Remove provider
        </button>
      )}
    </div>
  );
}

/** a custom OpenAI-compatible provider: name, base URL, model discovery and its model list */
function CustomProviderEditor(props: { p: ProviderStatus; onChanged: (p?: ProviderStatus) => void }) {
  const { p } = props;
  const prov = settings.value?.pi.customProviders?.find((x) => x.id === p.id);
  const models = prov?.models ?? [];
  const [name, setName] = useState(p.name);
  const [url, setUrl] = useState(prov?.baseUrl ?? p.baseUrl ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [found, setFound] = useState<{ id: string; ownedBy?: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState('');
  const have = new Set(models.map((m) => m.id));
  const clean = url.trim().replace(/\/+$/, '');
  const dirty = clean !== (prov?.baseUrl ?? '') || (name.trim() && name.trim() !== p.name);

  const patch = async (body: Record<string, unknown>, ok?: string) => {
    try {
      const r = await api.patch<ProviderStatus>(`/custom-providers/${encodeURIComponent(p.id)}`, body);
      if (ok) toast(ok, 'success');
      props.onChanged(r);
      return r;
    } catch (e: any) {
      toast(`${p.name}: ${e?.message ?? e}`, 'error');
      return null;
    }
  };
  const save = async () => {
    setBusy('save');
    await patch({ name: name.trim() || p.name, baseUrl: clean }, 'Provider saved');
    setBusy(null);
  };
  const discover = async () => {
    setBusy('discover');
    setErr(null);
    try {
      setFound(await api.get<{ id: string; ownedBy?: string }[]>(`/providers/${encodeURIComponent(p.id)}/discover?baseUrl=${encodeURIComponent(clean)}`));
    } catch (e: any) {
      setFound(null);
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };
  const setModels = async (next: CustomModel[], ok?: string) => {
    setBusy('models');
    const body: Record<string, unknown> = { models: next };
    if (dirty && clean !== (prov?.baseUrl ?? '')) body.baseUrl = clean;
    await patch(body, ok);
    setBusy(null);
  };
  const add = (ids: string[]) => {
    const fresh = ids.map((x) => x.trim()).filter((id) => id && !have.has(id));
    if (!fresh.length) return;
    void setModels([...models, ...fresh.map((id) => ({ id, name: id, baseUrl: '', contextWindow: 32768 }))], fresh.length === 1 ? `Added ${fresh[0]}` : `Added ${fresh.length} models`);
  };
  const removeModel = (id: string) => void setModels(models.filter((m) => m.id !== id), `Removed ${id}`);
  const setCtx = (id: string, v: number) => void setModels(models.map((m) => (m.id === id ? { ...m, contextWindow: v } : m)));

  const shown = (found ?? []).filter((m) => !filter || m.id.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div class="flex flex-col gap-3">
      <div class="grid grid-cols-1 md:grid-cols-[minmax(0,200px)_minmax(0,1fr)] gap-2">
        <div>
          <div class="hud-label text-[10px] mb-1.5">Name</div>
          <input class={INPUT} value={name} placeholder="e.g. OpenRouter" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </div>
        <div>
          <div class="hud-label text-[10px] mb-1.5 flex items-center gap-1.5">
            <Link2 size={11} /> Base URL
          </div>
          <input
            class={`${INPUT} font-mono`}
            placeholder="https://api.example.com/v1  ·  http://localhost:11434/v1"
            value={url}
            spellcheck={false}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && dirty && void save()}
          />
        </div>
      </div>
      <div class="flex gap-2 items-center">
        <button class={`${BTN} btn-primary h-8`} disabled={!dirty || busy === 'save'} onClick={() => void save()}>
          {busy === 'save' && <span class="loading loading-spinner loading-xs" />}Save
        </button>
        <button class={`${BTN_OUT} h-8`} disabled={!clean || busy === 'discover'} onClick={() => void discover()} title="List the models this endpoint serves (uses the API key below)">
          {busy === 'discover' ? <span class="loading loading-spinner loading-xs" /> : <Search size={11} />} Discover models
        </button>
        <span class="text-[11px] text-fg-3">
          Provider id <span class="font-mono text-fg-2">{p.id}</span> · usually ends in <span class="font-mono">/v1</span>
        </span>
      </div>
      {err && <div class="font-mono text-[11.5px] text-red">{err}</div>}
      {found && (
        <div class="border border-line">
          <div class="flex items-center gap-2 px-2.5 py-1.5 border-b border-line">
            <span class="font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3">{found.length} available</span>
            {found.length > 8 && <input class={`${INPUT} input-xs font-mono max-w-[220px]`} placeholder="Filter…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />}
            {shown.some((m) => !have.has(m.id)) && shown.length <= 50 && (
              <button class={`${BTN_OUT} ml-auto`} disabled={busy === 'models'} onClick={() => add(shown.map((m) => m.id))}>
                <Plus size={11} /> Add all{filter ? ' shown' : ''}
              </button>
            )}
            <button class="text-fg-3 hover:text-fg-2 ml-auto" title="Close" onClick={() => setFound(null)}>
              ×
            </button>
          </div>
          <div class="max-h-[220px] overflow-y-auto">
            {shown.length === 0 && <div class="px-2.5 py-2 text-[12px] text-fg-3">No models.</div>}
            {shown.map((m) => (
              <div key={m.id} class="flex items-center gap-2 px-2.5 py-1 border-b border-line/50 last:border-b-0">
                <span class="font-mono text-[12px] text-fg truncate">{m.id}</span>
                {m.ownedBy && <span class="font-mono text-[10px] text-fg-3 truncate">{m.ownedBy}</span>}
                {have.has(m.id) ? (
                  <span class="ml-auto flex items-center gap-1 font-mono text-[10px] uppercase text-fg-3">
                    <Check size={11} /> Added
                  </span>
                ) : (
                  <button class={`${BTN_OUT} ml-auto`} disabled={busy === 'models'} onClick={() => add([m.id])}>
                    <Plus size={11} /> Add
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div class="hud-label text-[10px] mb-1.5">Models · {models.length}</div>
        <div class="border border-line">
          {models.length === 0 && <div class="px-2.5 py-2 text-[12px] text-fg-3">No models yet — discover them or add an id below.</div>}
          {models.map((m) => (
            <div key={m.id} class="flex items-center gap-2 px-2.5 py-1 border-b border-line/50 last:border-b-0">
              <span class="font-mono text-[12px] text-fg truncate flex-1 min-w-0" title={m.baseUrl ? `own URL: ${m.baseUrl}` : undefined}>
                {m.id}
                {m.baseUrl && <span class="text-fg-3"> · own URL</span>}
              </span>
              <label class="flex items-center gap-1 font-mono text-[10px] text-fg-3" title="Context window (tokens)">
                ctx
                <input
                  class={`${INPUT} input-xs font-mono !w-[90px]`}
                  type="number"
                  min={1024}
                  step={1024}
                  value={m.contextWindow ?? 32768}
                  onChange={(e) => {
                    const v = Number((e.target as HTMLInputElement).value);
                    if (v > 0 && v !== m.contextWindow) setCtx(m.id, v);
                  }}
                />
              </label>
              <button class="text-fg-3 hover:text-red p-1" title={`Remove ${m.id}`} disabled={busy === 'models'} onClick={() => removeModel(m.id)}>
                <Trash2 size={12} strokeWidth={1.5} />
              </button>
            </div>
          ))}
          <div class="flex items-center gap-2 px-2.5 py-1.5 border-t border-line/50">
            <input
              class={`${INPUT} input-xs font-mono`}
              placeholder="model id, e.g. gpt-4.1-mini or llama3.1:8b"
              value={manual}
              spellcheck={false}
              onInput={(e) => setManual((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && manual.trim()) {
                  add([manual]);
                  setManual('');
                }
              }}
            />
            <button
              class={BTN_OUT}
              disabled={!manual.trim() || busy === 'models'}
              onClick={() => {
                add([manual]);
                setManual('');
              }}
            >
              <Plus size={11} /> Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
