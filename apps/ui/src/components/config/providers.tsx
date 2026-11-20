/** Config → Providers: status table, ping, API keys, OAuth login/logout. */
import { useState } from 'preact/hooks';
import type { CustomModel, OAuthFlowState, ProviderStatus } from '@monarch/shared';
import { ChevronRight, Activity, KeyRound, LogIn, LogOut, RefreshCw, Link2, Search, Plus, Check, Trash2 } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { oauthFlows, settings, toast, useResource } from '../../lib/store.ts';
import { Panel, Tag, Spinner, ErrorLine, Empty, Skeleton, Btn } from '../ui.tsx';
import { INPUT, Kbd } from './fields.tsx';
import { OAuthFlowView } from './oauth-flow.tsx';


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
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState('');
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

  const q = query.trim().toLowerCase();
  const connected = list.filter((p) => p.configured || p.error || p.custom);
  const catalog = list.filter((p) => !(p.configured || p.error || p.custom)).filter((p) => !q || `${p.name} ${p.id}`.toLowerCase().includes(q));
  const row = (p: ProviderStatus) => (
    <ProviderRow
      key={p.id}
      p={p}
      open={open === p.id}
      pinging={!!pinging[p.id]}
      onToggle={() => setOpen(open === p.id ? null : p.id)}
      onPing={() => void ping(p.id)}
      onChanged={(np) => (np ? replace(np) : void res.reload())}
      onRemoved={() => {
        setOpen(null);
        void res.reload();
      }}
    />
  );

  return (
    <div class="flex flex-col gap-4">
      <Panel
        title="Connected"
        right={
          <>
            {res.data && <span class="text-[12px] text-fg-3">{configured} ready</span>}
            <select
              class="select select-xs h-7 bg-transparent border-line rounded-[var(--radius-control)] text-[12px] w-[120px]"
              value={engineFilter}
              onChange={(e) => setEngineFilter((e.target as HTMLSelectElement).value as typeof engineFilter)}
              aria-label="Filter by engine"
            >
              <option value="all">All engines</option>
              <option value="claude-sdk">Claude SDK</option>
              <option value="pi">pi</option>
            </select>
            <button key="refresh-btn" class="text-fg-3 hover:text-fg-2 p-1" title="Refresh" onClick={() => void res.reload()}>
              <RefreshCw size={13} strokeWidth={1.5} class={res.loading ? 'animate-spin' : ''} />
            </button>
          </>
        }
      >
        {res.loading && !res.data ? (
          <Skeleton lines={3} class="py-2" />
        ) : res.error && !res.data ? (
          <ErrorLine error={res.error} />
        ) : connected.length === 0 ? (
          <Empty>Nothing connected yet. Add a provider below to get started.</Empty>
        ) : (
          <div class="flex flex-col gap-1 -mx-2">{connected.map(row)}</div>
        )}
      </Panel>

      <Panel
        title="Add a provider"
        right={
          <Btn size="xs" onClick={() => void addCustom()} disabled={adding} title="Add an OpenAI-compatible provider (OpenAI, OpenRouter, Together, Groq, vLLM, Ollama, LM Studio…)">
            {adding ? <span class="loading loading-spinner loading-xs" /> : <Plus size={12} />} Custom provider
          </Btn>
        }
      >
        {!browsing ? (
          <div class="flex flex-wrap items-center gap-3">
            <p class="text-[13px] text-fg-2 flex-1 min-w-[220px]">
              {catalog.length} more providers are available, from Anthropic and OpenAI to local servers.
            </p>
            <Btn size="xs" onClick={() => setBrowsing(true)}>
              <Search size={12} /> Browse providers
            </Btn>
          </div>
        ) : (
          <div class="flex flex-col gap-3">
            <label class={`${INPUT} flex items-center gap-2`}>
              <Search size={14} class="text-fg-3" />
              <input
                class="grow"
                placeholder="Search providers…"
                value={query}
                autoFocus
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                aria-label="Search providers"
              />
            </label>
            {catalog.length === 0 ? <Empty>No providers match “{query}”.</Empty> : <div class="flex flex-col gap-1 -mx-2">{catalog.map(row)}</div>}
            <button class="self-start text-[12.5px] text-fg-3 hover:text-fg-2" onClick={() => (setBrowsing(false), setQuery(''))}>
              Hide catalog
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}

function ProviderRow(props: {
  p: ProviderStatus;
  open: boolean;
  pinging: boolean;
  onToggle: () => void;
  onPing: () => void;
  onChanged: (p?: ProviderStatus) => void;
  onRemoved: () => void;
}) {
  const { p } = props;
  const status = p.error ? (
    <Tag tone="red" title={p.error}>
      error
    </Tag>
  ) : p.configured ? (
    <Tag tone="ok">ready</Tag>
  ) : null;
  return (
    <div id={`prov-${p.id}`} class={`rounded-[8px] transition-colors duration-150 ${props.open ? 'bg-raised' : 'hover:bg-raised/60'}`}>
      <div class="flex items-center gap-3 px-3 py-2.5 cursor-pointer" onClick={props.onToggle} role="button" aria-expanded={props.open}>
        <ChevronRight size={13} class={`text-fg-3 shrink-0 transition-transform duration-150 ${props.open ? 'rotate-90' : ''}`} />
        <div class="flex-1 min-w-0">
          <div class="text-[13.5px] text-fg truncate">
            {p.name}
            {p.custom && <span class="text-fg-3 text-[12px]"> · custom</span>}
          </div>
          <div class="text-[12px] text-fg-3 truncate">
            {p.account ? p.account : p.source && p.source !== 'none' ? p.source : p.authKinds.join(' or ')}
            {p.configured && p.modelCount ? ` · ${p.modelCount} models` : ''}
            {p.latencyMs !== undefined ? <span class={p.latencyMs > 2000 ? 'text-warning' : ''}> · {Math.round(p.latencyMs)} ms</span> : null}
          </div>
        </div>
        <span class="hidden sm:inline font-mono text-[11px] text-fg-3">{p.engine === 'pi' ? 'pi' : 'claude'}</span>
        {status}
        {p.configured && (
          <button
            class="text-fg-3 hover:text-fg-2 p-1 disabled:opacity-40"
            disabled={props.pinging}
            onClick={(e) => (e.stopPropagation(), props.onPing())}
            title="Measure round-trip"
            aria-label={`Ping ${p.name}`}
          >
            {props.pinging ? <span class="loading loading-spinner loading-xs" /> : <Activity size={13} />}
          </button>
        )}
      </div>
      {props.open && (
        <div class="px-3 pb-4 pl-9">
          <ProviderDetail p={p} onChanged={props.onChanged} onRemoved={props.onRemoved} />
        </div>
      )}
    </div>
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
            <Btn size="sm" variant="primary" disabled={!key.trim() || busy === 'key'} onClick={() => void saveKey()}>
              {busy === 'key' && <span class="loading loading-spinner loading-xs" />}Save
            </Btn>
            {p.source === 'stored-key' && (
              <Btn size="sm" disabled={busy === 'clear'} onClick={() => void clearKey()}>
                Clear
              </Btn>
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
                <Btn size="xs" disabled={busy === 'logout'} onClick={() => void logout()}>
                  <LogOut size={11} /> Logout
                </Btn>
                <Btn size="xs" disabled={busy === 'login' || !!flow} onClick={() => void login()}>
                  Re-login
                </Btn>
              </>
            ) : (
              <Btn size="xs" variant="primary" disabled={busy === 'login' || (!!flow && flow.status !== 'error')} onClick={() => void login()}>
                {busy === 'login' ? <span class="loading loading-spinner loading-xs" /> : <LogIn size={11} />} Login with {p.name}
              </Btn>
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
          <Btn size="xs" variant="danger" disabled={busy} onClick={() => void remove()}>
            {busy && <span class="loading loading-spinner loading-xs" />}Remove
          </Btn>
          <Btn size="xs" onClick={() => setArmed(false)}>
            Cancel
          </Btn>
        </>
      ) : (
        <Btn size="xs" class="hover:!text-red hover:!border-red/60" onClick={() => setArmed(true)}>
          <Trash2 size={11} /> Remove provider
        </Btn>
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
        <Btn size="sm" variant="primary" disabled={!dirty || busy === 'save'} onClick={() => void save()}>
          {busy === 'save' && <span class="loading loading-spinner loading-xs" />}Save
        </Btn>
        <Btn size="sm" disabled={!clean || busy === 'discover'} onClick={() => void discover()} title="List the models this endpoint serves (uses the API key below)">
          {busy === 'discover' ? <span class="loading loading-spinner loading-xs" /> : <Search size={11} />} Discover models
        </Btn>
        <span class="text-[11px] text-fg-3">
          Provider id <span class="font-mono text-fg-2">{p.id}</span> · usually ends in <span class="font-mono">/v1</span>
        </span>
      </div>
      {err && <div class="font-mono text-[11.5px] text-red">{err}</div>}
      {found && (
        <div class="border border-line">
          <div class="flex items-center gap-2 px-2.5 py-1.5 border-b border-line">
            <span class=" text-[12px] text-fg-3">{found.length} available</span>
            {found.length > 8 && <input class={`${INPUT} input-xs font-mono max-w-[220px]`} placeholder="Filter…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />}
            {shown.some((m) => !have.has(m.id)) && shown.length <= 50 && (
              <Btn size="xs" class="ml-auto" disabled={busy === 'models'} onClick={() => add(shown.map((m) => m.id))}>
                <Plus size={11} /> Add all{filter ? ' shown' : ''}
              </Btn>
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
                  <span class="ml-auto flex items-center gap-1 text-[12px] text-fg-3">
                    <Check size={11} /> Added
                  </span>
                ) : (
                  <Btn size="xs" class="ml-auto" disabled={busy === 'models'} onClick={() => add([m.id])}>
                    <Plus size={11} /> Add
                  </Btn>
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
            <Btn size="xs"
              disabled={!manual.trim() || busy === 'models'}
              onClick={() => {
                add([manual]);
                setManual('');
              }}
            >
              <Plus size={11} /> Add
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
