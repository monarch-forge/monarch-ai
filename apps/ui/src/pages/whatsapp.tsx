/** WhatsApp: chats (unread first by recency) + message view + reply box. Modeled on the Slack page. */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { WhatsAppChat, WhatsAppMessage, WhatsAppStatus } from '@monarch/shared';
import { CheckCheck, MessageCircle, Send, Users, X } from 'lucide-preact';
import { api } from '../lib/api.ts';
import { navigate, toast, useResource } from '../lib/store.ts';
import { Btn, ListRow } from '../components/ui.tsx';
import { Button, LoadError, Loading, relTime, StateBlock } from '../components/mail/kit.tsx';

const enc = encodeURIComponent;

export default function WhatsAppPage(props: { params: string[] }) {
  const chatId = props.params[0] ? decodeURIComponent(props.params[0]) : null;
  const st = useResource<WhatsAppStatus>('/whatsapp/status', ['whatsapp']);
  const linked = st.data && st.data.state !== 'unlinked' && st.data.state !== 'pairing';
  const chatsRes = useResource<WhatsAppChat[]>(linked ? '/whatsapp/chats' : null, ['whatsapp']);
  const msgRes = useResource<WhatsAppMessage[]>(linked && chatId ? `/whatsapp/chats/${enc(chatId)}/messages?limit=200` : null, ['whatsapp']);
  const [filter, setFilter] = useState('');
  const chats = (chatsRes.data ?? []).filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
  const chat = chatsRes.data?.find((c) => c.id === chatId);

  if (st.data === undefined)
    return <div class="h-full flex items-center justify-center p-4">{st.error ? <LoadError error={st.error} onRetry={st.reload} /> : <Loading label="Checking WhatsApp" />}</div>;
  if (!linked)
    return (
      <div class="h-full flex items-center justify-center p-4">
        <StateBlock
          icon={<MessageCircle size={18} strokeWidth={1.5} />}
          title="WhatsApp not linked"
          actions={
            <Btn pill variant="primary" onClick={() => navigate('config/accounts')}>
              Link WhatsApp
            </Btn>
          }
        >
          Link your phone by QR and Monarch can read your chats and reply for you (after you approve).
        </StateBlock>
      </div>
    );

  const markRead = async () => {
    try {
      await api.post(`/whatsapp/chats/${enc(chatId!)}/read`, {});
    } catch (e: any) {
      toast(`Mark read failed: ${e?.message ?? e}`, 'error');
    }
  };

  return (
    <div class="h-full flex gap-4 min-h-0 p-3 sm:p-4 lg:p-5">
      <aside class={`${chatId ? 'hidden lg:flex' : 'flex'} w-full lg:w-64 shrink-0 flex-col min-h-0`}>
        <div class="flex items-center gap-2 px-2 py-1">
          <span class="text-[14px] font-semibold text-fg flex-1 truncate">{st.data.me?.name ?? 'WhatsApp'}</span>
          {st.data.state !== 'open' && <span class="text-[11.5px] text-fg-3">{st.data.state}…</span>}
        </div>
        <input
          class="mt-3 w-full bg-transparent border border-line rounded-full px-3 py-2 text-[13px] text-fg placeholder:text-fg-3 outline-none focus:border-[#6a6a70] transition-colors"
          placeholder="Jump to…"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          aria-label="Filter chats"
        />
        <div class="flex-1 min-h-0 overflow-y-auto pt-2">
          {chatsRes.error && !chatsRes.data ? (
            <LoadError error={chatsRes.error} onRetry={chatsRes.reload} />
          ) : chatsRes.data === undefined ? (
            <Loading label="Listing chats" />
          ) : !chats.length ? (
            <StateBlock
              icon={<MessageCircle size={18} strokeWidth={1.5} />}
              title={filter ? 'No match' : 'No chats yet'}
              actions={filter ? <Btn pill onClick={() => setFilter('')}>Clear filter</Btn> : <Btn pill onClick={() => void chatsRes.reload()}>Refresh</Btn>}
            >{filter ? `Nothing matches “${filter}”.` : 'New messages show up here as they arrive.'}</StateBlock>
          ) : (
            chats.map((c) => {
              const active = c.id === chatId;
              return (
                <ListRow outline
                  key={c.id}
                  active={active}
                  marker
                  class="py-1.5"
                  attrs={{ title: c.lastText }}
                  onClick={() => navigate(`whatsapp/${enc(c.id)}`)}
                  lead={c.isGroup ? <Users size={13} /> : <MessageCircle size={13} />}
                  title={<span class={c.unread ? 'text-fg font-semibold' : active ? 'text-fg' : 'text-fg-2'}>{c.name}</span>}
                  trail={!!c.unread && <span class="font-mono text-[11px] text-fg-2">{c.unread > 99 ? '99+' : c.unread}</span>}
                />
              );
            })
          )}
        </div>
      </aside>

      <section class={`${chatId ? 'flex' : 'hidden lg:flex'} flex-1 min-w-0 flex-col min-h-0 bg-base-200 rounded-[var(--radius-card)] overflow-hidden`}>
        {!chatId ? (
          <div class="flex-1 flex items-center justify-center"><StateBlock icon={<MessageCircle size={18} strokeWidth={1.5} />} title="Pick a chat">Choose a conversation on the left to read and reply.</StateBlock></div>
        ) : (
          <>
            <header class="flex items-center gap-2 px-4 sm:px-5 pt-3.5 pb-2.5">
              <Btn pill variant="ghost" size="xs" class="lg:hidden -ml-1 btn-square" aria-label="Back to chats" onClick={() => navigate('whatsapp')}>
                <X size={15} />
              </Btn>
              <h1 class="flex-1 min-w-0 text-[13px] font-medium uppercase tracking-[0.12em] text-fg truncate">{chat?.name ?? chatId}</h1>
              {!!chat?.unread && (
                <Btn pill size="xs" variant="ghost" onClick={markRead} title="Mark read">
                  <CheckCheck size={13} /> Mark read
                </Btn>
              )}
            </header>
            <Messages res={msgRes} isGroup={!!chat?.isGroup} />
            <Composer chatId={chatId} label={chat?.name ?? chatId} disabled={st.data.state !== 'open'} />
          </>
        )}
      </section>
    </div>
  );
}

function Messages(props: { res: { data?: WhatsAppMessage[]; error?: string; reload?: () => void }; isGroup: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const list = props.res.data;
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [list?.length]);
  if (props.res.error && !list) return <LoadError error={props.res.error} onRetry={props.res.reload} />;
  if (!list) return <Loading label="Loading messages" />;
  return (
    <div ref={ref} class="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-2 flex flex-col gap-1.5">
      {!list.length && <div class="m-auto text-[13px] text-fg-3">Only messages received since linking are shown.</div>}
      {list.map((m) => (
        <div key={m.id} class={`max-w-[80%] rounded-[var(--radius-card)] px-3 py-1.5 text-[13.5px] leading-relaxed ${m.fromMe ? 'self-end bg-white/[0.08]' : 'self-start bg-white/[0.04]'}`}>
          {props.isGroup && !m.fromMe && <div class="text-[11.5px] font-semibold text-fg-2">{m.senderName}</div>}
          <div class="whitespace-pre-wrap break-words text-fg">{m.text}</div>
          <div class="text-[10.5px] text-fg-3 text-right">{relTime(new Date(m.ts).toISOString())}</div>
        </div>
      ))}
    </div>
  );
}

function Composer(props: { chatId: string; label: string; disabled: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(''), [props.chatId]);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.post(`/whatsapp/chats/${enc(props.chatId)}/send`, { text: t });
      setText('');
    } catch (e: any) {
      toast(`Send failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="px-3 sm:px-4 pb-3 sm:pb-4">
      <div class="flex items-end gap-2 rounded-[var(--radius-control)] bg-white/[0.04] focus-within:bg-white/[0.06] transition-colors">
        <textarea
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          class="flex-1 bg-transparent outline-none resize-none px-3.5 py-2.5 text-[14px] leading-relaxed text-fg placeholder:text-fg-3"
          placeholder={props.disabled ? 'Reconnecting…' : `Message ${props.label}`}
          title="Enter to send · Shift+Enter for a new line"
          value={text}
          disabled={props.disabled}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label={`Message ${props.label}`}
        />
        <Button variant="primary" size="xs" class="m-1.5" loading={busy} disabled={!text.trim() || props.disabled} onClick={() => void send()} title="Send (Enter)">
          <Send size={12} />
        </Button>
      </div>
    </div>
  );
}
