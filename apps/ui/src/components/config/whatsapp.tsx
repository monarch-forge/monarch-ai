/** Config → Accounts: WhatsApp (personal number, linked as a device by QR). */
import { useState } from 'preact/hooks';
import type { WhatsAppStatus } from '@monarch/shared';
import { api } from '../../lib/api.ts';
import { toast, useResource } from '../../lib/store.ts';
import { Btn, ErrorLine, Panel, Spinner, Tag } from '../ui.tsx';

const TONE = { open: 'ok', pairing: 'warn', connecting: 'warn', closed: 'red', unlinked: 'plain' } as const;

export function WhatsAppAccount() {
  const res = useResource<WhatsAppStatus>('/whatsapp/status', ['whatsapp']);
  const [busy, setBusy] = useState(false);
  const s = res.data;
  const run = async (path: string, done?: string) => {
    setBusy(true);
    try {
      await api.post(path, {}); // status refetches on data.changed('whatsapp')
      if (done) toast(done, 'success');
    } catch (e: any) {
      toast(`WhatsApp: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="WhatsApp" right={s ? <Tag tone={TONE[s.state]}>{s.state}</Tag> : res.loading ? <Spinner /> : null}>
      {res.error && !s && <ErrorLine error={res.error} />}
      {s?.state === 'open' && (
        <div class="flex items-center gap-3">
          <div class="flex-1 text-[13px] text-fg">
            {s.me?.name ?? 'Linked'} <span class="font-mono text-[10px] text-fg-3">+{s.me?.id.split('@')[0]}</span>
          </div>
          <Btn pill size="xs" loading={busy} onClick={() => run('/whatsapp/logout', 'WhatsApp unlinked')}>
            Unlink
          </Btn>
        </div>
      )}
      {s?.state === 'pairing' && s.qr && (
        <div class="flex items-start gap-4">
          <img src={s.qr} alt="WhatsApp pairing QR code" class="w-[200px] h-[200px] bg-white p-1 rounded" />
          <div class="text-[12px] text-fg-2 flex flex-col gap-2">
            <div>On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan.</div>
            <Btn pill size="xs" variant="ghost" loading={busy} onClick={() => run('/whatsapp/logout')}>
              Cancel
            </Btn>
          </div>
        </div>
      )}
      {s && (s.state === 'unlinked' || s.state === 'closed' || s.state === 'connecting') && (
        <div class="flex flex-col gap-2">
          {s.error && <ErrorLine error={s.error} />}
          <div class="text-[12px] text-fg-3">
            Links your personal number as a device via an unofficial bridge. WhatsApp may restrict accounts that use it.
          </div>
          <div class="flex gap-2">
            <Btn pill size="xs" variant="primary" loading={busy || s.state === 'connecting'} onClick={() => run('/whatsapp/pair')}>
              {s.state === 'unlinked' ? 'Link via QR' : 'Reconnect'}
            </Btn>
            {s.state !== 'unlinked' && (
              <Btn pill size="xs" loading={busy} onClick={() => run('/whatsapp/logout', 'WhatsApp unlinked')}>
                Unlink
              </Btn>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
