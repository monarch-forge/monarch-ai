/** Mail composer — used inline for replies and inside the "Compose" modal. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GoogleAccount, MailDraft } from '@monarch/shared';
import { Send, Save } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { toast } from '../../lib/store.ts';
import { Btn } from '../ui.tsx';
import { AccountMark, Button, Modal } from './kit.tsx';

export interface ComposerInit {
  accountId: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}

export function Composer(props: {
  init: ComposerInit;
  accounts: GoogleAccount[];
  /** lock the from-account (replies) */
  lockAccount?: boolean;
  onDone: (sent: boolean) => void;
  compact?: boolean;
}) {
  const [d, setD] = useState<ComposerInit>(props.init);
  const [showCc, setShowCc] = useState(!!props.init.cc);
  const [busy, setBusy] = useState<'send' | 'draft' | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setD(props.init);
    setShowCc(!!props.init.cc);
  }, [props.init]);
  useEffect(() => {
    // replies: focus the body at the top (above the quote)
    if (props.init.threadId && bodyRef.current) {
      bodyRef.current.focus();
      bodyRef.current.setSelectionRange(0, 0);
    }
  }, [props.init]);

  const valid = !!d.accountId && d.to.trim().length > 2 && /@/.test(d.to);
  const draft = (): MailDraft => ({
    accountId: d.accountId,
    to: d.to.trim(),
    cc: d.cc?.trim() || undefined,
    subject: d.subject,
    body: d.body,
    threadId: d.threadId,
    inReplyTo: d.inReplyTo,
  });

  const send = async () => {
    if (!valid || busy) return;
    setBusy('send');
    try {
      await api.post<{ id: string }>('/mail/send', draft());
      toast(`Sent to ${d.to.trim()}`, 'success');
      props.onDone(true);
    } catch (e: any) {
      toast(`Send failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const saveDraft = async () => {
    if (!d.accountId || busy) return;
    setBusy('draft');
    try {
      await api.post<{ id: string }>('/mail/drafts', draft());
      toast('Draft saved to Gmail', 'success');
      props.onDone(false);
    } catch (e: any) {
      toast(`Draft failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const field = 'w-full bg-transparent outline-none text-[13.5px] text-fg placeholder:text-fg-3 py-2';
  const row = 'flex items-center gap-3 border-b border-white/[0.05] px-5';
  const lab = 'text-[12.5px] text-fg-3 w-14 shrink-0';
  const from = props.accounts.find((a) => a.id === d.accountId);

  return (
    <div
      class="flex flex-col min-h-0 h-full"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          void send();
        }
      }}
    >
      <div class={row}>
        <span class={lab}>From</span>
        {props.lockAccount || props.accounts.length <= 1 ? (
          <span class="flex items-center gap-2 text-[13px] text-fg-2 py-1.5">
            <AccountMark id={d.accountId} /> {from?.email ?? d.accountId}
          </span>
        ) : (
          <select
            class="select select-ghost select-sm px-0 text-[13px] focus:outline-none flex-1 h-8 min-h-8"
            value={d.accountId}
            onChange={(e) => setD({ ...d, accountId: (e.target as HTMLSelectElement).value })}
            aria-label="From account"
          >
            {props.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ? `${a.name} <${a.email}>` : a.email}
              </option>
            ))}
          </select>
        )}
      </div>
      <div class={row}>
        <span class={lab}>To</span>
        <input class={field} value={d.to} onInput={(e) => setD({ ...d, to: (e.target as HTMLInputElement).value })} placeholder="name@example.com, …" aria-label="To" />
        {!showCc && (
          <button class="text-[12px] text-fg-3 hover:text-fg" onClick={() => setShowCc(true)}>
            Cc
          </button>
        )}
      </div>
      {showCc && (
        <div class={row}>
          <span class={lab}>Cc</span>
          <input class={field} value={d.cc ?? ''} onInput={(e) => setD({ ...d, cc: (e.target as HTMLInputElement).value })} aria-label="Cc" />
        </div>
      )}
      <div class={row}>
        <span class={lab}>Subject</span>
        <input class={field} value={d.subject} onInput={(e) => setD({ ...d, subject: (e.target as HTMLInputElement).value })} aria-label="Subject" />
      </div>
      <textarea
        ref={bodyRef}
        class={`flex-1 w-full bg-transparent outline-none resize-none px-5 py-3 text-[14px] leading-[1.65] text-fg placeholder:text-fg-3 ${props.compact ? 'min-h-36' : 'min-h-64'}`}
        value={d.body}
        onInput={(e) => setD({ ...d, body: (e.target as HTMLTextAreaElement).value })}
        placeholder="Write your message…"
        aria-label="Message body"
      />
      <div class="flex items-center gap-2 px-5 py-3">
        <span class="text-[11.5px] text-fg-3 hidden md:inline">Ctrl+Enter to send</span>
        <Btn variant="ghost" size="xs" class="ml-auto" onClick={() => props.onDone(false)}>
          Discard
        </Btn>
        <Button size="xs" loading={busy === 'draft'} disabled={!d.accountId || !!busy} onClick={saveDraft} title="Save as Gmail draft">
          <Save size={12} /> Draft
        </Button>
        <Button variant="primary" size="xs" loading={busy === 'send'} disabled={!valid || !!busy} onClick={send}>
          <Send size={12} /> Send
        </Button>
      </div>
    </div>
  );
}

export function ComposeModal(props: { open: boolean; onClose: () => void; accounts: GoogleAccount[]; defaultAccount?: string }) {
  const [init, setInit] = useState<ComposerInit>({ accountId: '', to: '', subject: '', body: '' });
  useEffect(() => {
    if (props.open) setInit({ accountId: props.defaultAccount && props.accounts.some((a) => a.id === props.defaultAccount) ? props.defaultAccount : (props.accounts[0]?.id ?? ''), to: '', subject: '', body: '' });
  }, [props.open]);
  return (
    <Modal open={props.open} onClose={props.onClose} title="New message" width="max-w-2xl">
      <div class="-mx-5 -mb-4 h-[60vh] flex flex-col">
        <Composer init={init} accounts={props.accounts} onDone={() => props.onClose()} />
      </div>
    </Modal>
  );
}
