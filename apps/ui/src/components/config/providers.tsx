/** Config → Providers: status table, ping, API keys, OAuth login/logout. */
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { OAuthFlowState, ProviderStatus } from '@monarch/shared';
import { ChevronRight, Activity, KeyRound, LogIn, LogOut, RefreshCw } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { oauthFlows, toast, useResource } from '../../lib/store.ts';
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

  const list = (res.data ?? []).filter((p) => engineFilter === 'all' || p.engine === engineFilter);
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
                    <tr class={`border-line cursor-pointer hover:bg-white/[0.02] ${isOpen ? 'bg-subtle/50' : ''}`} onClick={() => setOpen(isOpen ? null : p.id)}>
                      <td>
                        <ChevronRight size={12} class={`text-fg-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                      </td>
                      <td>
                        <div class="text-[13px] text-fg">{p.name}</div>
                        <div class="font-mono text-[10px] text-fg-3">{p.id}</div>
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
                          <ProviderDetail p={p} onChanged={(np) => (np ? replace(np) : void res.reload())} />
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

function ProviderDetail(props: { p: ProviderStatus; onChanged: (p?: ProviderStatus) => void }) {
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
      {p.authKinds.includes('local') && <div class="text-[12.5px] text-fg-2">Local endpoint — no credentials needed. Configure models under Models → Custom models.</div>}

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
    </div>
  );
}
