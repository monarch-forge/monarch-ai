/** Config → Phone access: optional second listener (Tailscale / LAN) for the phone, device pairing and revoke. */
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../../lib/api.ts';
import { toast } from '../../lib/store.ts';
import { Btn, ErrorLine, Panel, Tag, fmt } from '../ui.tsx';
import { Field, INPUT, SELECT, ToggleRow } from './fields.tsx';

interface RemoteStatus {
  config: { enabled: boolean; iface: 'tailscale' | 'lan'; address: string; port: number };
  running: { address: string; port: number; url: string } | null;
  error: string | null;
  tailscale: string | null;
  lan: string[];
  uiBuilt: boolean;
  devices: { id: string; name: string; createdAt: string; lastSeen: string | null }[];
}
interface PairingCode {
  code: string;
  expiresAt: number;
  url: string;
  qrSvg: string;
}

const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function RemoteSection() {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<PairingCode | null>(null);
  const [port, setPort] = useState('');

  const load = () =>
    api
      .get<RemoteStatus>('/remote/status')
      .then((s) => {
        setSt(s);
        setPort(String(s.config.port));
      })
      .catch((e) => setErr(msg(e)));
  useEffect(() => void load(), []);

  const save = async (patch: Partial<RemoteStatus['config']>) => {
    setBusy(true);
    setErr(undefined);
    setPair(null);
    try {
      const s = await api.put<RemoteStatus>('/remote/config', patch);
      setSt(s);
      setPort(String(s.config.port));
      if (s.error) setErr(s.error);
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const newCode = async () => {
    try {
      setPair(await api.post<PairingCode>('/remote/pairing'));
    } catch (e) {
      setErr(msg(e));
    }
  };

  const revoke = async (id: string, name: string) => {
    if (!confirm(`Revoke ${name}? It loses access immediately.`)) return;
    try {
      setSt(await api.del<RemoteStatus>(`/remote/devices/${encodeURIComponent(id)}`));
      toast(`Revoked ${name}`, 'success');
    } catch (e) {
      setErr(msg(e));
    }
  };

  if (!st) return <Panel title="Phone access">{err ? <ErrorLine error={err} /> : <div class="skeleton h-24 w-full" />}</Panel>;
  const c = st.config;

  return (
    <div class="flex flex-col gap-4">
      <Panel title="Phone access" right={st.running ? <Tag tone="ok">on · {st.running.url}</Tag> : <Tag>off</Tag>}>
        <div class="rounded-[var(--radius-control)] border border-warning/40 bg-warning/5 p-3 text-[13px] text-fg-2 mb-3">
          A paired phone gets the same power as this desktop: it can read your mail, send messages and run commands. Only
          enable this on networks you trust — Tailscale is recommended. Traffic is plain HTTP (Tailscale encrypts it; on a
          LAN anyone on the network can watch it).
        </div>
        <ToggleRow
          label="Allow phone access"
          hint="Opens a second, authenticated listener. The desktop app keeps using 127.0.0.1."
          checked={c.enabled}
          disabled={busy}
          onChange={(v) => void save({ enabled: v })}
        />
        <div class="grid gap-3 sm:grid-cols-3 mt-2">
          <Field label="Network">
            <select class={SELECT} value={c.iface} disabled={busy} onChange={(e) => void save({ iface: (e.target as HTMLSelectElement).value as 'tailscale' | 'lan' })}>
              <option value="tailscale">Tailscale {st.tailscale ? `(${st.tailscale})` : '(not detected)'}</option>
              <option value="lan">Local network</option>
            </select>
          </Field>
          {c.iface === 'lan' && (
            <Field label="Address">
              <select class={SELECT} value={c.address} disabled={busy} onChange={(e) => void save({ address: (e.target as HTMLSelectElement).value })}>
                <option value="">Choose…</option>
                {st.lan.map((a) => (
                  <option value={a}>{a}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Port">
            <input
              class={INPUT}
              inputMode="numeric"
              value={port}
              disabled={busy}
              onInput={(e) => setPort((e.target as HTMLInputElement).value)}
              onBlur={() => port !== String(c.port) && void save({ port: Number(port) })}
            />
          </Field>
        </div>
        {!st.uiBuilt && <p class="text-[12.5px] text-fg-3 mt-2">The web UI is not built yet (npm run build) — the phone will only get the API.</p>}
        <ErrorLine error={err} />
      </Panel>

      {st.running && (
        <Panel title="Pair a phone" right={<Btn pill size="xs" onClick={() => void newCode()}>{pair ? 'New code' : 'Show pairing code'}</Btn>}>
          {pair ? (
            <div class="flex flex-col sm:flex-row gap-4 items-start animate-monarch-fade">
              <div class="w-44 h-44 rounded-[var(--radius-control)] overflow-hidden bg-white p-1 shrink-0" dangerouslySetInnerHTML={{ __html: pair.qrSvg }} />
              <div class="text-[13px] text-fg-2 flex flex-col gap-2 min-w-0">
                <p>Scan with the phone camera (it must be on the same {c.iface === 'tailscale' ? 'tailnet' : 'network'}), then tap Pair.</p>
                <code class="break-all text-fg text-[12px]">{pair.url}</code>
                <p class="text-fg-3">One-time code, valid until {new Date(pair.expiresAt).toLocaleTimeString()}.</p>
              </div>
            </div>
          ) : (
            <p class="text-[13px] text-fg-3">Generates a one-time QR code valid for 5 minutes.</p>
          )}
        </Panel>
      )}

      <Panel title="Paired devices" right={<Tag>{st.devices.length}</Tag>}>
        {st.devices.length ? (
          <ul class="divide-y divide-line monarch-stagger">
            {st.devices.map((d) => (
              <li class="flex items-center gap-3 py-2 text-[13px]">
                <span class="flex-1 min-w-0 truncate text-fg">{d.name}</span>
                <span class="text-fg-3 text-[12px]">{d.lastSeen ? `seen ${fmt.ago(d.lastSeen)}` : 'never seen'}</span>
                <Btn pill size="xs" variant="ghost" onClick={() => void revoke(d.id, d.name)}>
                  Revoke
                </Btn>
              </li>
            ))}
          </ul>
        ) : (
          <p class="text-[13px] text-fg-3">No devices paired.</p>
        )}
      </Panel>
    </div>
  );
}
