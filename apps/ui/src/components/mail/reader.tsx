/** Thread reader: message cards (text by default, sandboxed HTML on demand), actions, inline reply. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { GoogleAccount, MailMessage, MailThread } from '@monarch/shared';
import { Archive, Mail, MailOpen, Reply, ReplyAll, Sparkles, Star, PenLine, X, Image, Code } from 'lucide-preact';
import { openExternal } from '../../lib/api.ts';
import { Tag } from '../ui.tsx';
import { AccountMark, addresses, askMonarch, displayName, LoadError, Loading, StateBlock, shortStamp } from './kit.tsx';
import { Composer, type ComposerInit } from './composer.tsx';

export type MailAction = 'archive' | 'read' | 'unread' | 'star' | 'unstar';

export function ThreadReader(props: {
  accountId: string;
  threadId: string;
  thread: MailThread | undefined;
  loading: boolean;
  error?: string;
  reload: () => void;
  labels: string[];
  accounts: GoogleAccount[];
  onAction: (a: MailAction) => void;
  onClose: () => void;
  /** set from the page (keyboard r / a) */
  replyMode: 'reply' | 'all' | null;
  setReplyMode: (m: 'reply' | 'all' | null) => void;
}) {
  const t = props.thread;
  const msgs = useMemo(() => (Array.isArray(t?.messages) ? t!.messages.filter(Boolean) : []), [t]);
  const account = props.accounts.find((a) => a.id === props.accountId);
  const me = (account?.email ?? '').toLowerCase();
  const unread = props.labels.includes('UNREAD') || msgs.some((m) => m.labels?.includes('UNREAD'));
  const starred = props.labels.includes('STARRED') || msgs.some((m) => m.labels?.includes('STARRED'));
  const subject = t?.subject || msgs[0]?.subject || '(no subject)';

  const replyInit: ComposerInit | null = useMemo(() => {
    if (!props.replyMode || !msgs.length) return null;
    const last = msgs[msgs.length - 1];
    const fromMe = me && addresses(last.from).some((a) => a.toLowerCase() === me);
    const primary = fromMe ? addresses(last.to) : addresses(last.from);
    let cc: string[] = [];
    if (props.replyMode === 'all') {
      const seen = new Set([me, ...primary.map((a) => a.toLowerCase())]);
      cc = [...addresses(last.to), ...addresses(last.cc)].filter((a) => {
        const k = a.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    const quote = (last.text ?? '')
      .split('\n')
      .slice(0, 80)
      .map((l) => `> ${l}`)
      .join('\n');
    return {
      accountId: props.accountId,
      to: primary.join(', '),
      cc: cc.join(', ') || undefined,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      body: `\n\nOn ${new Date(last.date).toLocaleString()}, ${last.from} wrote:\n${quote}`,
      threadId: props.threadId,
      inReplyTo: last.messageIdHeader,
    };
  }, [props.replyMode, msgs, props.threadId]);

  const who = `Gmail account ${account?.email ?? props.accountId} (accountId: ${props.accountId})`;

  return (
    <div class="flex flex-col h-full min-h-0">
      {/* action bar */}
      <div class="flex items-center gap-0.5 px-2 py-1.5 border-b border-line">
        <IconBtn title="Reply (r)" onClick={() => props.setReplyMode('reply')} icon={<Reply size={14} />} />
        <IconBtn title="Reply all (a)" onClick={() => props.setReplyMode('all')} icon={<ReplyAll size={14} />} />
        <span class="w-px h-4 bg-line mx-1.5" />
        <IconBtn title="Archive (e)" onClick={() => props.onAction('archive')} icon={<Archive size={14} />} />
        <IconBtn
          title={unread ? 'Mark read (m)' : 'Mark unread (m)'}
          onClick={() => props.onAction(unread ? 'read' : 'unread')}
          icon={unread ? <MailOpen size={14} /> : <Mail size={14} />}
        />
        <IconBtn title={starred ? 'Unstar (s)' : 'Star (s)'} onClick={() => props.onAction(starred ? 'unstar' : 'star')} icon={<Star size={14} fill={starred ? 'currentColor' : 'none'} />} active={starred} />
        <span class="w-px h-4 bg-line mx-1.5" />
        <button
          class="btn btn-ghost btn-xs font-mono uppercase tracking-wider text-[10px] font-normal text-fg-2 hover:text-fg"
          title="Ask Monarch to summarize this thread"
          onClick={() => askMonarch(`Summarize the email thread ${props.threadId} in my ${who}. List the key points, decisions, and any action items or deadlines for me.`)}
        >
          <Sparkles size={12} /> Summarize
        </button>
        <button
          class="btn btn-ghost btn-xs font-mono uppercase tracking-wider text-[10px] font-normal text-fg-2 hover:text-fg"
          title="Ask Monarch to draft a reply (saved as a Gmail draft)"
          onClick={() =>
            askMonarch(`Read the email thread ${props.threadId} in my ${who} and draft a reply in my voice. Save it as a Gmail draft (do not send it) and show me the text.`)
          }
        >
          <PenLine size={12} /> Draft reply
        </button>
        <button class="ml-auto p-1.5 text-fg-3 hover:text-fg" title="Close (Esc)" aria-label="Close thread" onClick={props.onClose}>
          <X size={14} />
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto">
        {!t && props.error ? (
          <LoadError error={props.error} onRetry={props.reload} />
        ) : !t ? (
          <Loading label="Opening thread" />
        ) : (
          <div class="px-5 py-4">
            <div class="flex items-start gap-3">
              <h1 class="text-[17px] leading-snug text-fg font-medium flex-1">{subject}</h1>
              {props.loading && <span class="loading loading-spinner loading-xs text-fg-3 mt-1" />}
            </div>
            <div class="flex flex-wrap items-center gap-1.5 mt-2">
              <span class="inline-flex items-center gap-1.5 font-mono text-[10px] text-fg-3 mr-1">
                <AccountMark id={props.accountId} /> {account?.email ?? props.accountId}
              </span>
              {props.labels
                .filter((l) => !/^(CATEGORY_|UNREAD$|IMPORTANT$|STARRED$)/.test(l))
                .slice(0, 6)
                .map((l) => (
                  <Tag key={l} tone="plain">
                    {l.toLowerCase()}
                  </Tag>
                ))}
              <span class="ml-auto font-mono text-[10px] text-fg-3">{msgs.length} msg</span>
            </div>
            <div class="mt-4 flex flex-col gap-2">
              {msgs.length ? (
                msgs.map((m, i) => <MessageCard key={m.id} m={m} defaultOpen={i === msgs.length - 1 || !!m.labels?.includes('UNREAD')} me={me} />)
              ) : (
                <StateBlock title="Empty thread" />
              )}
            </div>
          </div>
        )}
      </div>

      {replyInit && (
        <div class="border-t border-line h-[46%] min-h-56 flex flex-col bg-[#18181a]">
          <Composer init={replyInit} accounts={props.accounts} lockAccount compact onDone={(sent) => {
            props.setReplyMode(null);
            if (sent) props.reload();
          }} />
        </div>
      )}
    </div>
  );
}

function IconBtn(props: { title: string; onClick: () => void; icon: preact.ComponentChildren; active?: boolean }) {
  return (
    <button class={`p-1.5 hover:bg-subtle ${props.active ? 'text-fg' : 'text-fg-2 hover:text-fg'}`} title={props.title} aria-label={props.title} onClick={props.onClick}>
      {props.icon}
    </button>
  );
}

/* ───────────────────────── message ───────────────────────── */

function MessageCard(props: { m: MailMessage; defaultOpen: boolean; me: string }) {
  const m = props.m;
  const [open, setOpen] = useState(props.defaultOpen);
  const [html, setHtml] = useState(false);
  const [images, setImages] = useState(false);
  const [quoted, setQuoted] = useState(false);
  useEffect(() => setOpen(props.defaultOpen), [m.id]);
  const fromMe = !!props.me && addresses(m.from).some((a) => a.toLowerCase() === props.me);
  const { main, quote } = useMemo(() => splitQuote(m.text ?? ''), [m.text]);

  if (!open) {
    return (
      <button class="text-left border border-line px-3 py-2 hover:bg-white/[0.02] flex items-baseline gap-3" onClick={() => setOpen(true)}>
        <span class="text-[13px] text-fg-2 shrink-0 max-w-[40%] truncate">{fromMe ? 'me' : displayName(m.from)}</span>
        <span class="text-xs text-fg-3 truncate flex-1">{(m.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}</span>
        <span class="font-mono text-[10px] text-fg-3 shrink-0">{shortStamp(m.date)}</span>
      </button>
    );
  }
  return (
    <article class="border border-line bg-[#18181a]">
      <header class="flex items-start gap-3 px-3.5 py-2.5 border-b border-line cursor-pointer" onClick={() => setOpen(false)}>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-[13px] text-fg font-medium truncate">{fromMe ? 'me' : displayName(m.from)}</span>
            <span class="font-mono text-[10px] text-fg-3 truncate">{addresses(m.from)[0] ?? ''}</span>
          </div>
          <div class="text-[11px] text-fg-3 mt-0.5 truncate">
            to {m.to}
            {m.cc ? ` · cc ${m.cc}` : ''}
          </div>
        </div>
        <span class="font-mono text-[10px] text-fg-3 shrink-0" title={m.date}>
          {new Date(m.date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
        </span>
      </header>
      {m.html && (
        <div class="flex items-center gap-1 px-3.5 pt-2">
          <button
            class={`font-mono text-[10px] tracking-widest uppercase px-1.5 py-0.5 border inline-flex items-center gap-1 ${html ? 'border-fg-3 text-fg' : 'border-line text-fg-3 hover:text-fg-2'}`}
            onClick={() => setHtml(!html)}
            aria-pressed={html}
          >
            <Code size={10} /> {html ? 'Showing HTML' : 'Show HTML'}
          </button>
          {html && (
            <button
              class={`font-mono text-[10px] tracking-widest uppercase px-1.5 py-0.5 border inline-flex items-center gap-1 ${images ? 'border-fg-3 text-fg' : 'border-line text-fg-3 hover:text-fg-2'}`}
              onClick={() => setImages(!images)}
              aria-pressed={images}
              title="Remote images can reveal that you opened the mail"
            >
              <Image size={10} /> {images ? 'Images on' : 'Load images'}
            </button>
          )}
        </div>
      )}
      <div class="px-3.5 py-3">
        {html && m.html ? (
          <iframe
            sandbox=""
            srcDoc={wrapHtml(m.html, images)}
            title={`HTML body of message from ${displayName(m.from)}`}
            class="w-full h-[60vh] bg-white border border-line resize-y"
            referrerpolicy="no-referrer"
          />
        ) : (
          <>
            <div class="whitespace-pre-wrap text-[13px] leading-relaxed text-fg/90 break-words">{linkify(main.trim() || '(no text body)')}</div>
            {quote && (
              <div class="mt-2">
                <button class="font-mono text-[10px] text-fg-3 hover:text-fg-2 border border-line px-1.5 leading-4" onClick={() => setQuoted(!quoted)} title="Toggle quoted text">
                  ···
                </button>
                {quoted && <div class="whitespace-pre-wrap text-xs leading-relaxed text-fg-3 mt-2 border-l border-line pl-3 break-words">{linkify(quote)}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}

/** separate the trailing quoted reply ("On … wrote:" / "> " lines) from the new text */
function splitQuote(text: string): { main: string; quote: string } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let idx = lines.findIndex((l) => /^On .{4,300}wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()));
  if (idx < 0) {
    // trailing block of "> " lines
    let j = lines.length - 1;
    while (j >= 0 && (lines[j].startsWith('>') || !lines[j].trim())) j--;
    if (j < lines.length - 1 && lines.slice(j + 1).some((l) => l.startsWith('>'))) idx = j + 1;
  }
  if (idx <= 0) return { main: text, quote: '' };
  return { main: lines.slice(0, idx).join('\n'), quote: lines.slice(idx).join('\n') };
}

/** turn bare URLs into links that open externally (no innerHTML) */
function linkify(text: string): preact.ComponentChildren {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        href={p}
        class="underline decoration-fg-3 underline-offset-2 hover:decoration-red break-all"
        onClick={(e) => {
          e.preventDefault();
          void openExternal(p);
        }}
      >
        {p}
      </a>
    ) : (
      p
    ),
  );
}

/** wrap sanitized email HTML into a locked-down document (no scripts via sandbox; CSP blocks remote loads unless allowed) */
function wrapHtml(html: string, allowImages: boolean): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:${allowImages ? ' https: http:' : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:12px;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1c1e;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${html}</body></html>`;
}
