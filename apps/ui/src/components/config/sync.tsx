/** Config → Sync: encrypted backup of all Monarch data to a private git repo (gh / glab / plain git). */
import { createPortal } from 'preact/compat';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { SyncProvider, SyncProviders, SyncSettings, SyncSnapshot, SyncStatus } from '@monarch/shared';
import { CloudUpload, History, KeyRound, Link2, RotateCcw } from 'lucide-preact';
import { ApiError, api } from '../../lib/api.ts';
import { conn, onCollectionChanged, settings, toast } from '../../lib/store.ts';
import { socket } from '../../lib/api.ts';
import { Btn, ErrorLine, Panel, Tag, fmt } from '../ui.tsx';
import { Modal, relTime, useConfirm } from '../mail/kit.tsx';
import { Field, INPUT, Kbd, SELECT, SaveBar, ToggleRow, saveSettings, useDraft } from './fields.tsx';

type Collection = Parameters<typeof onCollectionChanged>[0];

/** GET with status-code awareness (404 = backend not ready) */
function useSyncGet<T>(path: string | null, collections: Collection[]) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  // overlapping reloads (one per ws 'sync' event) can resolve out of order; only the newest may win,
  // otherwise a response taken mid-operation ("busy") can land last and leave buttons disabled
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    if (!path) {
      setData(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    try {
      const d = await api.get<T>(path);
      if (mine !== seq.current) return;
      setData(d);
      setError(undefined);
      setMissing(false);
    } catch (e: any) {
      if (mine !== seq.current) return;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
    const offs = collections.map((c) => onCollectionChanged(c, () => void reload()));
    const offConn = socket.onStatus((s) => s === 'open' && void reload());
    return () => {
      offs.forEach((o) => o());
      offConn();
    };
  }, [path]);
  const set = useCallback((v: T | undefined) => {
    seq.current++;
    setData(v);
  }, []);
  return { data, error, missing, loading, reload, setData: set };
}

const PROVIDERS: { id: SyncProvider; label: string; cli: 'gh' | 'glab' | 'git' }[] = [
  { id: 'github', label: 'GitHub (gh)', cli: 'gh' },
  { id: 'gitlab', label: 'GitLab (glab)', cli: 'glab' },
  { id: 'git', label: 'Git remote', cli: 'git' },
];

function strength(p: string): { label: string; tone: 'red' | 'warn' | 'ok' } {
  let s = 0;
  if (p.length >= 12) s++;
  if (p.length >= 16) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  if (p.length < 8 || s <= 1) return { label: 'weak', tone: 'red' };
  if (s <= 3) return { label: 'fair', tone: 'warn' };
  return { label: 'strong', tone: 'ok' };
}

function statusTag(st: SyncStatus | undefined) {
  const encOff = settings.value?.sync?.encrypt === false;
  if (!st || !st.configured || !(st.passphraseSet || encOff) || !st.remoteReady) return <Tag>Not set up</Tag>;
  if (st.error) return <Tag tone="red">Error</Tag>;
  if (st.busy) return <Tag tone="warn">{st.busy === 'push' ? 'Uploading…' : st.busy === 'pull' ? 'Restoring…' : 'Checking…'}</Tag>;
  if (st.localChanged) return <Tag tone="warn">Changes not synced</Tag>;
  const last = [st.lastPushAt, st.lastPullAt].filter(Boolean).sort().pop();
  if (last) return <Tag tone="ok">Synced {relTime(last)}</Tag>;
  return <Tag tone="ok">Ready</Tag>;
}

const snapLabel = (s: { device: string; createdAt: string }) => `${s.device} at ${fmt.dateTime(s.createdAt)}`;

export function SyncSection() {
  const status = useSyncGet<SyncStatus>('/sync/status', ['sync', 'settings']);
  const providers = useSyncGet<SyncProviders>('/sync/providers', ['settings']);
  // history only exists once a remote is connected
  const history = useSyncGet<SyncSnapshot[]>(status.data?.remoteReady ? '/sync/history?limit=30' : null, ['sync']);
  const [draft, set, dirty, reset] = useDraft<SyncSettings>(settings.value?.sync);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'' | 'pass' | 'connect' | 'push' | 'pull'>('');
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [conflict, setConflict] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [dialog, confirm] = useConfirm();

  // restoring overlay: wait for the socket to drop and come back (or a fallback if it never drops)
  const sawDrop = useRef(false);
  useEffect(() => {
    if (!restoring) return;
    if (conn.value !== 'open') sawDrop.current = true;
    else if (sawDrop.current) {
      sawDrop.current = false;
      setRestoring(false);
      toast('Restore complete — Monarch data replaced from the snapshot', 'success');
      void api.get<any>('/settings').then((s) => (settings.value = s)).catch(() => {});
      void status.reload();
      void history.reload();
    }
  }, [restoring, conn.value]);
  useEffect(() => {
    if (!restoring) return;
    // fallback: if the socket never dropped (fast restart), end the overlay after 20s once online
    const t = window.setTimeout(() => {
      if (!sawDrop.current && conn.value === 'open') {
        sawDrop.current = true;
        setRestoring(false);
        toast('Restore complete', 'success');
        void status.reload();
      }
    }, 20000);
    return () => window.clearTimeout(t);
  }, [restoring]);

  if (status.missing) {
    return (
      <Panel title="Sync">
        <div class=" text-[12px] text-fg-3 py-8 text-center">Sync service unavailable</div>
      </Panel>
    );
  }
  if (!draft) return null;

  const st = status.data;
  const pv = providers.data;
  const cliInstalled = (cli: 'gh' | 'glab' | 'git') => (pv ? pv[cli].installed && pv.git.installed : true);
  const accounts = (pv?.accounts ?? []).filter((a) => a.provider === draft.provider).sort((a, b) => Number(b.active) - Number(a.active));
  const encrypt = settings.value?.sync?.encrypt !== false;
  const ready = !!(st?.configured && (st.passphraseSet || !encrypt) && st.remoteReady);
  const repoPlaceholder = `${draft.account || '<login>'}/monarch-sync`;
  const passOk = pass1.length >= 8 && pass1 === pass2;
  const str = strength(pass1);

  const save = async () => {
    setSaving(true);
    const ok = await saveSettings({ sync: draft }, 'Sync settings saved');
    setSaving(false);
    if (ok) reset();
  };

  const setPassphrase = async () => {
    setBusy('pass');
    try {
      status.setData(await api.put<SyncStatus>('/sync/passphrase', { passphrase: pass1 }));
      setPass1('');
      setPass2('');
      toast('Sync passphrase set on this device', 'success');
    } catch (e: any) {
      toast(`Passphrase failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const connect = async () => {
    setBusy('connect');
    try {
      if (dirty) {
        const ok = await saveSettings({ sync: { ...draft, enabled: true } }, false);
        if (!ok) return;
        reset();
      } else if (!draft.enabled) await saveSettings({ sync: { enabled: true } }, false);
      const s = await api.post<SyncStatus>('/sync/connect');
      status.setData(s);
      void status.reload();
      toast(s.remoteReady ? `Connected to ${s.remoteUrl ?? 'remote'}` : 'Connect finished, remote not ready', s.remoteReady ? 'success' : 'warn');
      void history.reload();
    } catch (e: any) {
      toast(`Connect failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const push = async (force = false) => {
    setConflict(false);
    setBusy('push');
    try {
      status.setData(await api.post<SyncStatus>('/sync/push', force ? { force: true } : {}));
      toast('Snapshot uploaded', 'success');
      void history.reload();
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      else toast(`Sync failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const restore = async (snap?: SyncSnapshot) => {
    setConflict(false);
    const target = snap ?? st?.remote;
    const ok = await confirm({
      title: 'Restore from remote',
      body: (
        <p class="text-[13px] text-fg-2 leading-relaxed">
          This replaces this device's Monarch data with the snapshot from{' '}
          <span class="text-fg">{target ? snapLabel(target) : 'the remote'}</span>. A backup of the current data is kept. Monarch will restart.
        </p>
      ),
      confirmLabel: 'Restore',
      danger: true,
    });
    if (!ok) return;
    setBusy('pull');
    try {
      const r = await api.post<{ restored: boolean; restarting: boolean }>('/sync/pull', snap ? { commit: snap.commit } : {});
      if (r?.restarting) {
        sawDrop.current = conn.value !== 'open';
        setRestoring(true);
      } else {
        toast('Restore complete', 'success');
        void status.reload();
      }
    } catch (e: any) {
      toast(`Restore failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <Panel title="Encrypted sync" right={statusTag(st)}>
        <p class="text-[13px] text-fg-2 leading-relaxed">
          Backs up all Monarch data — settings, secrets and tokens, sessions, memory vault, extensions, skills and stores — to a private git repo you own. Everything is
          encrypted on this device with your passphrase before it leaves; GitHub or GitLab only ever see ciphertext.
        </p>
        <p class="text-[12px] text-warning mt-2">Losing the passphrase means losing the backup. It cannot be recovered.</p>
        <ErrorLine error={st?.error ?? status.error} />
      </Panel>

      <Panel title="1 · Provider" right={<Link2 size={13} strokeWidth={1.5} class="text-fg-3" />}>
        <div class="grid gap-4 grid-cols-1 md:grid-cols-2">
          <Field label="Provider" htmlFor="sync-provider" hint={pv && !pv.git.installed ? 'git is not installed — sync needs git on this machine.' : undefined}>
            <select id="sync-provider" class={SELECT} value={draft.provider} onChange={(e) => set({ provider: (e.target as HTMLSelectElement).value as SyncProvider, account: '', host: '' })}>
              {PROVIDERS.map((p) => {
                const ok = cliInstalled(p.cli);
                const ver = pv?.[p.cli]?.version;
                return (
                  <option key={p.id} value={p.id} disabled={!ok}>
                    {p.label}
                    {ok ? (ver ? ` — ${ver}` : '') : ` — ${p.cli} not installed`}
                  </option>
                );
              })}
            </select>
          </Field>
          {draft.provider !== 'git' ? (
            <Field
              label="Account"
              htmlFor="sync-account"
              hint={
                <>
                  Log in more with <Kbd>{draft.provider === 'github' ? 'gh auth login' : 'glab auth login'}</Kbd>
                </>
              }
            >
              <select
                id="sync-account"
                class={SELECT}
                value={draft.account ? `${draft.account}@${draft.host}` : ''}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  const a = accounts.find((x) => `${x.login}@${x.host}` === v);
                  set({ account: a?.login ?? '', host: a?.host ?? '' });
                }}
              >
                <option value="">{accounts.length ? 'Choose an account…' : 'No logged-in accounts found'}</option>
                {accounts.map((a) => (
                  <option key={`${a.login}@${a.host}`} value={`${a.login}@${a.host}`}>
                    {a.login} @ {a.host}
                    {a.active ? ' (active)' : ''}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Remote URL" htmlFor="sync-remote" hint="Uses your own git credentials / SSH key.">
              <input id="sync-remote" class={INPUT} value={draft.remoteUrl} placeholder="git@host:you/monarch-sync.git" onInput={(e) => set({ remoteUrl: (e.target as HTMLInputElement).value })} />
            </Field>
          )}
          {draft.provider !== 'git' && (
            <Field label="Repository" htmlFor="sync-repo" hint="Created as a private repo if it doesn't exist.">
              <input id="sync-repo" class={INPUT} value={draft.repo} placeholder={repoPlaceholder} onInput={(e) => set({ repo: (e.target as HTMLInputElement).value })} />
            </Field>
          )}
          <Field label="Device name" htmlFor="sync-device" hint="Label for this machine in snapshots.">
            <input id="sync-device" class={INPUT} value={draft.deviceName} placeholder={location.hostname && location.hostname !== '127.0.0.1' ? location.hostname : 'my-laptop'} onInput={(e) => set({ deviceName: (e.target as HTMLInputElement).value })} />
          </Field>
          <Field label="Auto-sync" htmlFor="sync-auto" hint="Auto-sync only uploads; restoring is always manual.">
            <select id="sync-auto" class={SELECT} value={draft.autoSync} onChange={(e) => set({ autoSync: (e.target as HTMLSelectElement).value as SyncSettings['autoSync'] })}>
              <option value="off">Off</option>
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
            </select>
          </Field>
        </div>
        <details class="mt-4">
          <summary class="hud-label text-[10px] cursor-pointer select-none">Advanced</summary>
          <div class="grid gap-4 grid-cols-1 md:grid-cols-2 mt-3">
            <Field label="Branch" htmlFor="sync-branch">
              <input id="sync-branch" class={INPUT} value={draft.branch} placeholder="main" onInput={(e) => set({ branch: (e.target as HTMLInputElement).value })} />
            </Field>
          </div>
        </details>
        <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
      </Panel>

      <Panel
        title="2 · Encryption"
        right={!encrypt ? <Tag tone="warn">Off — readable in the repo</Tag> : st?.passphraseSet ? <Tag tone="ok">Passphrase set on this device</Tag> : <Tag>Not set</Tag>}
      >
        <ToggleRow
          label="Encrypt with a passphrase"
          hint={
            encrypt
              ? 'Recommended. GitHub only ever stores ciphertext; a new device needs the same passphrase.'
              : 'Off: snapshots are only compressed. The repo is still private, but anyone with access to it or to your GitHub token can read every API key and token in it.'
          }
          checked={encrypt}
          onChange={(on) => {
            void saveSettings({ sync: { encrypt: on } }, on ? 'Encryption on — set a passphrase to sync' : 'Encryption off — next sync uploads readable data').then(() => void status.reload());
          }}
        />
        {encrypt && (
          <div class="mt-3">
        <div class="grid gap-4 grid-cols-1 md:grid-cols-2">
          <Field label={st?.passphraseSet ? 'New passphrase' : 'Passphrase'} htmlFor="sync-pass1" hint={pass1 ? <span>Strength: <Tag tone={str.tone}>{str.label}</Tag></span> : 'At least 8 characters; a long phrase is best.'}>
            <input id="sync-pass1" type="password" autocomplete="new-password" class={INPUT} value={pass1} onInput={(e) => setPass1((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Repeat" htmlFor="sync-pass2" hint={pass2 && pass1 !== pass2 ? <span class="text-red">Passphrases don't match</span> : undefined}>
            <input id="sync-pass2" type="password" autocomplete="new-password" class={INPUT} value={pass2} onInput={(e) => setPass2((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <div class="flex flex-wrap items-center gap-3 mt-4">
          <span class="text-[12px] text-fg-3 flex-1 min-w-[200px]">
            Stored only on this device. There is no recovery — use the same passphrase on every device.
          </span>
          <Btn variant="primary" loading={busy === 'pass'} disabled={!passOk || !!busy} onClick={() => void setPassphrase()}>
            <KeyRound size={12} /> {st?.passphraseSet ? 'Change passphrase' : 'Set passphrase'}
          </Btn>
        </div>
          </div>
        )}
      </Panel>

      <Panel title="3 · Connect" right={st?.remoteReady ? <Tag tone="ok">connected</Tag> : <Tag>not connected</Tag>}>
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-[13px] text-fg-2 flex-1 min-w-[200px] break-all">
            {st?.remoteUrl ? <span class="font-mono text-[12px] text-fg">{st.remoteUrl}</span> : 'Creates the private repo if missing and verifies access.'}
          </span>
          <Btn
            variant={st?.remoteReady ? 'outline' : 'primary'}
            loading={busy === 'connect'}
            disabled={!!busy || (draft.provider === 'git' ? !draft.remoteUrl.trim() : !draft.account) || (pv ? !cliInstalled(PROVIDERS.find((p) => p.id === draft.provider)!.cli) : false)}
            onClick={() => void connect()}
          >
            <Link2 size={12} /> {st?.remoteReady ? 'Reconnect' : 'Connect'}
          </Btn>
        </div>
      </Panel>

      {ready && (
        <Panel title="Sync" right={st!.localChanged ? <Tag tone="warn">local changes</Tag> : <Tag tone="ok">up to date</Tag>}>
          <div class="grid gap-3 grid-cols-2 md:grid-cols-4 font-mono text-[11px]">
            <Info label="Last upload" value={relTime(st!.lastPushAt)} />
            <Info label="Last restore" value={relTime(st!.lastPullAt)} />
            <Info label="Remote from" value={st!.remote ? st!.remote.device : '—'} />
            <Info label="Remote snapshot" value={st!.remote ? `${relTime(st!.remote.createdAt)} · ${fmt.bytes(st!.remote.bytes)}` : 'none yet'} />
          </div>
          <div class="flex flex-wrap gap-2 mt-4">
            <Btn variant="primary" loading={busy === 'push' || st!.busy === 'push'} disabled={!!busy || !!st!.busy} onClick={() => void push()}>
              <CloudUpload size={12} /> Sync now
            </Btn>
            <Btn loading={busy === 'pull'} disabled={!!busy || !!st!.busy || !st!.remote} onClick={() => void restore()}>
              <RotateCcw size={12} /> Restore from remote
            </Btn>
          </div>
        </Panel>
      )}

      {ready && (
        <Panel title="History" right={<History size={13} strokeWidth={1.5} class="text-fg-3" />} noPad>
          {history.error && <div class="px-3.5"><ErrorLine error={history.error} /></div>}
          {!history.data?.length ? (
            <div class="text-[12px] text-fg-3 px-3.5 py-4">{history.loading ? 'Loading…' : 'No snapshots yet.'}</div>
          ) : (
            <ul class="divide-y divide-line">
              {history.data.map((h) => (
                <li key={h.commit} class="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5">
                  <span class="text-[13px] text-fg min-w-[150px]">{fmt.dateTime(h.createdAt)}</span>
                  <span class="text-[12px] text-fg-2 flex-1 min-w-[100px] truncate">{h.device}</span>
                  <span class="font-mono text-[11px] text-fg-3">{fmt.bytes(h.bytes)}</span>
                  <span class="font-mono text-[11px] text-fg-3">{h.commit.slice(0, 7)}</span>
                  <Btn size="xs" disabled={!!busy} onClick={() => void restore(h)}>
                    Restore this version
                  </Btn>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      <Modal
        open={conflict}
        onClose={() => setConflict(false)}
        code="409"
        title="Remote is newer"
        width="max-w-md"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConflict(false)}>Cancel</Btn>
            <Btn onClick={() => void push(true)}>Force push</Btn>
            <Btn variant="primary" data-autofocus onClick={() => void restore()}>Pull (restore)</Btn>
          </>
        }
      >
        <p class="text-[13px] text-fg-2 leading-relaxed">
          Another device uploaded a newer snapshot{st?.remote ? <> (<span class="text-fg">{snapLabel(st.remote)}</span>)</> : null}. Restore it here, or force push to overwrite it with this
          device's data — the remote snapshot stays in history.
        </p>
      </Modal>

      {dialog}

      {restoring &&
        createPortal(
          <div class="fixed inset-0 z-[1000] bg-[#121213]/95 flex flex-col items-center justify-center gap-4" role="alertdialog" aria-live="assertive">
            <span class="loading loading-spinner loading-md text-red" />
            <div class=" text-[12px] text-fg">Restoring…</div>
            <div class=" text-[12px] text-fg-3">{conn.value === 'open' ? 'waiting for core restart' : 'reconnecting'}</div>
          </div>,
          document.body,
        )}
    </>
  );
}

function Info(props: { label: string; value: string }) {
  return (
    <div class="flex flex-col gap-1">
      <span class="hud-label text-[10px]">{props.label}</span>
      <span class="text-fg-2">{props.value}</span>
    </div>
  );
}
