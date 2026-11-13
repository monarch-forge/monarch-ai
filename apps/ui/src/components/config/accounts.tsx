/** Config → Accounts: Google OAuth client + accounts, Slack workspaces. */
import { useEffect, useState } from 'preact/hooks';
import type { GoogleAccount, GoogleClientConfig, OAuthFlowState, SlackWorkspace } from '@monarch/shared';
import { Plus, Check, X, ExternalLink } from 'lucide-preact';
import { api, openExternal } from '../../lib/api.ts';
import { oauthFlows, toast, useResource } from '../../lib/store.ts';
import { Panel, Tag, Spinner, ErrorLine, Empty, fmt } from '../ui.tsx';
import { Field, INPUT, Kbd } from './fields.tsx';
import { OAuthFlowView } from './oauth-flow.tsx';

const BTN = 'btn btn-xs rounded-[2px] font-mono font-normal uppercase tracking-wider text-[10px]';
const BTN_OUT = `${BTN} btn-outline border-line text-fg-2 hover:bg-subtle hover:border-fg-3 hover:text-fg`;

const SLACK_SCOPES = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'users:read',
  'search:read',
  'chat:write',
];

function ConfirmRemove(props: { label: string; onConfirm: () => Promise<void> }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!ask)
    return (
      <button class={BTN_OUT} onClick={() => setAsk(true)}>
        {props.label}
      </button>
    );
  return (
    <span class="flex items-center gap-1.5">
      <span class="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">sure?</span>
      <button
        class="text-red hover:text-fg p-0.5"
        disabled={busy}
        title="Confirm"
        onClick={async () => {
          setBusy(true);
          await props.onConfirm();
          setBusy(false);
          setAsk(false);
        }}
      >
        {busy ? <Spinner /> : <Check size={13} />}
      </button>
      <button class="text-fg-3 hover:text-fg p-0.5" title="Cancel" onClick={() => setAsk(false)}>
        <X size={13} />
      </button>
    </span>
  );
}

export function AccountsSection() {
  return (
    <div class="flex flex-col gap-3">
      <GoogleClient />
      <GoogleAccounts />
      <SlackWorkspaces />
    </div>
  );
}

function GoogleClient() {
  const res = useResource<GoogleClientConfig>('/google/client', ['google']);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [showSteps, setShowSteps] = useState<boolean | null>(null);

  useEffect(() => {
    if (res.data) setClientId(res.data.clientId ?? '');
  }, [res.data?.clientId]);

  const configured = !!res.data?.configured;
  const steps = showSteps ?? !configured;
  const dirty = clientId.trim() !== (res.data?.clientId ?? '') || !!secret.trim();

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.put<GoogleClientConfig>('/google/client', { clientId: clientId.trim(), clientSecret: secret.trim() || res.data?.clientSecret || '' });
      res.setData(next);
      setSecret('');
      toast('Google OAuth client saved', 'success');
    } catch (e: any) {
      toast(`Save failed: ${e?.message ?? e}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      code="CFG.41"
      title="Google OAuth client"
      right={res.loading && !res.data ? <Spinner /> : configured ? <Tag tone="ok">configured</Tag> : <Tag tone="warn">required</Tag>}
    >
      <div class="text-[12.5px] text-fg-2 leading-relaxed">
        Gmail and Calendar use your own Google Cloud OAuth client, so tokens never leave this machine.
        <button class="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3 hover:text-fg-2" onClick={() => setShowSteps(!steps)}>
          {steps ? 'hide steps' : 'setup steps'}
        </button>
      </div>
      {steps && (
        <ol class="mt-3 flex flex-col gap-1.5 text-[12.5px] text-fg-2 list-none">
          {[
            <>
              Open the{' '}
              <button class="underline decoration-red underline-offset-2 text-fg inline-flex items-center gap-1" onClick={() => void openExternal('https://console.cloud.google.com/apis/credentials')}>
                Google Cloud console <ExternalLink size={10} />
              </button>{' '}
              and create (or pick) a project.
            </>,
            <>
              Enable the <b class="text-fg font-medium">Gmail API</b> and the <b class="text-fg font-medium">Google Calendar API</b> (APIs &amp; Services → Library).
            </>,
            <>
              Configure the OAuth consent screen (External), and add your Google address under <b class="text-fg font-medium">Test users</b>.
            </>,
            <>
              Credentials → Create credentials → OAuth client ID → application type <b class="text-fg font-medium">Desktop app</b>.
            </>,
            <>Paste the client ID and secret below, save, then connect accounts.</>,
          ].map((s, i) => (
            <li key={i} class="flex gap-3">
              <span class="font-mono text-[10px] text-fg-3 pt-0.5 w-5 shrink-0">{String(i + 1).padStart(2, '0')}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      )}
      <ErrorLine error={res.error && !res.data ? res.error : undefined} />
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <Field label="Client ID">
          <input class={`${INPUT} font-mono`} value={clientId} onInput={(e) => setClientId((e.target as HTMLInputElement).value)} placeholder="1234-abc.apps.googleusercontent.com" spellcheck={false} />
        </Field>
        <Field label="Client secret">
          <input
            class={`${INPUT} font-mono`}
            type="password"
            autoComplete="off"
            value={secret}
            onInput={(e) => setSecret((e.target as HTMLInputElement).value)}
            placeholder={configured ? `${res.data?.clientSecret || '••••••••'} — paste to replace` : 'GOCSPX-…'}
          />
        </Field>
      </div>
      <div class="flex justify-end mt-3">
        <button class={`${BTN} btn-primary btn-sm h-8`} disabled={!dirty || saving || !clientId.trim() || (!configured && !secret.trim())} onClick={() => void save()}>
          {saving && <span class="loading loading-spinner loading-xs" />}Save client
        </button>
      </div>
    </Panel>
  );
}

function GoogleAccounts() {
  const client = useResource<GoogleClientConfig>('/google/client', ['google']);
  const res = useResource<GoogleAccount[]>('/google/accounts', ['google']);
  const [flow, setFlow] = useState<OAuthFlowState | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    try {
      const f = await api.post<OAuthFlowState>('/google/accounts/connect', {});
      oauthFlows.value = { ...oauthFlows.value, [f.flowId]: oauthFlows.value[f.flowId] ?? f };
      setFlow(f);
    } catch (e: any) {
      toast(`Connect failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (a: GoogleAccount) => {
    try {
      await api.del(`/google/accounts/${encodeURIComponent(a.id)}`);
      res.setData((res.data ?? []).filter((x) => x.id !== a.id));
      toast(`Disconnected ${a.email}`, 'success');
    } catch (e: any) {
      toast(`Disconnect failed: ${e?.message ?? e}`, 'error');
    }
  };

  const configured = !!client.data?.configured;

  return (
    <Panel
      code="CFG.42"
      title="Google accounts"
      right={
        <button class={`${BTN} btn-primary`} disabled={!configured || busy || (!!flow && flow.status !== 'error' && flow.status !== 'done')} onClick={() => void connect()} title={configured ? 'Connect a Google account' : 'Configure the OAuth client first'}>
          {busy ? <span class="loading loading-spinner loading-xs" /> : <Plus size={11} />} Connect
        </button>
      }
    >
      {flow && (
        <div class="mb-3">
          <OAuthFlowView
            initial={flow}
            autoOpen
            onFinished={(f) => {
              if (f.status === 'done') {
                toast('Google account connected', 'success');
                void res.reload();
                window.setTimeout(() => setFlow(null), 2500);
              }
            }}
            onDismiss={() => setFlow(null)}
          />
        </div>
      )}
      {res.loading && !res.data ? (
        <div class="flex justify-center py-4">
          <Spinner />
        </div>
      ) : res.error && !res.data ? (
        <ErrorLine error={res.error} />
      ) : !res.data?.length ? (
        <div class="text-[12.5px] text-fg-3 py-2">{configured ? 'No accounts connected. Connect as many Gmail / Calendar accounts as you like.' : 'Save an OAuth client above to connect accounts.'}</div>
      ) : (
        <div class="flex flex-col">
          {res.data.map((a) => (
            <div key={a.id} class="flex items-center gap-3 py-2 border-b border-line last:border-b-0">
              {a.picture ? (
                <img src={a.picture} alt="" class="w-7 h-7 rounded-[2px] grayscale opacity-80" referrerpolicy="no-referrer" />
              ) : (
                <div class="w-7 h-7 border border-line flex items-center justify-center font-mono text-[11px] text-fg-2 uppercase">{(a.name || a.email)[0]}</div>
              )}
              <div class="flex-1 min-w-0">
                <div class="text-[13px] text-fg truncate">
                  {a.email} {a.label && <span class="font-mono text-[10px] text-fg-3 ml-1">{a.label}</span>}
                </div>
                <div class="font-mono text-[10px] text-fg-3 truncate">
                  {a.name ? `${a.name} · ` : ''}
                  {a.scopes.some((s) => s.includes('gmail')) ? 'gmail ' : ''}
                  {a.scopes.some((s) => s.includes('calendar')) ? 'calendar ' : ''}· since {fmt.date(a.connectedAt)}
                </div>
                {a.error && <div class="font-mono text-[11px] text-red mt-0.5">{a.error}</div>}
              </div>
              {a.error ? <Tag tone="red">error</Tag> : <Tag tone="ok">linked</Tag>}
              <ConfirmRemove label="Disconnect" onConfirm={() => disconnect(a)} />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function SlackWorkspaces() {
  const res = useResource<SlackWorkspace[]>('/slack/workspaces', ['slack']);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [showScopes, setShowScopes] = useState(false);

  const add = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      const w = await api.post<SlackWorkspace>('/slack/workspaces', { token: token.trim() });
      res.setData([...(res.data ?? []).filter((x) => x.id !== w.id), w]);
      setToken('');
      toast(`Slack connected: ${w.name}`, 'success');
    } catch (e: any) {
      toast(`Slack: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (w: SlackWorkspace) => {
    try {
      await api.del(`/slack/workspaces/${encodeURIComponent(w.id)}`);
      res.setData((res.data ?? []).filter((x) => x.id !== w.id));
      toast(`Disconnected ${w.name}`, 'success');
    } catch (e: any) {
      toast(`Disconnect failed: ${e?.message ?? e}`, 'error');
    }
  };

  return (
    <Panel code="CFG.43" title="Slack workspaces" right={res.data ? <Tag>{res.data.length} linked</Tag> : res.loading ? <Spinner /> : null}>
      {res.error && !res.data ? (
        <ErrorLine error={res.error} />
      ) : res.data?.length ? (
        <div class="flex flex-col mb-4">
          {res.data.map((w) => (
            <div key={w.id} class="flex items-center gap-3 py-2 border-b border-line last:border-b-0">
              <div class="w-7 h-7 border border-line flex items-center justify-center font-mono text-[12px] text-fg-2">#</div>
              <div class="flex-1 min-w-0">
                <div class="text-[13px] text-fg truncate">{w.name}</div>
                <div class="font-mono text-[10px] text-fg-3">
                  {w.tokenType} token{w.user ? ` · ${w.user}` : ''} · {w.id} · since {fmt.date(w.connectedAt)}
                </div>
                {w.error && <div class="font-mono text-[11px] text-red mt-0.5">{w.error}</div>}
              </div>
              {w.error ? <Tag tone="red">error</Tag> : <Tag tone="ok">linked</Tag>}
              <ConfirmRemove label="Disconnect" onConfirm={() => remove(w)} />
            </div>
          ))}
        </div>
      ) : (
        !res.loading && <Empty class="!py-3 text-left">No workspaces linked</Empty>
      )}

      <Field
        label="Add workspace token"
        hint={
          <>
            Create a Slack app at{' '}
            <button class="underline decoration-red underline-offset-2 text-fg-2" onClick={() => void openExternal('https://api.slack.com/apps')}>
              api.slack.com/apps
            </button>
            , add the user-token scopes below, install it to your workspace, and paste the <Kbd>xoxp-…</Kbd> user token (or an <Kbd>xoxb-…</Kbd> bot token).{' '}
            <button class="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3 hover:text-fg-2" onClick={() => setShowScopes(!showScopes)}>
              {showScopes ? 'hide scopes' : 'show scopes'}
            </button>
          </>
        }
      >
        <div class="flex gap-2">
          <input
            class={`${INPUT} font-mono`}
            type="password"
            autoComplete="off"
            placeholder="xoxp-…"
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <button class={`${BTN} btn-primary h-8`} disabled={busy || !token.trim()} onClick={() => void add()}>
            {busy && <span class="loading loading-spinner loading-xs" />}Connect
          </button>
        </div>
      </Field>
      {showScopes && (
        <div class="mt-2 flex flex-wrap gap-1.5">
          {SLACK_SCOPES.map((s) => (
            <span key={s} class="font-mono text-[10.5px] text-fg-2 border border-line px-1.5 py-0.5">
              {s}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}
