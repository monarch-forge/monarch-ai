/**
 * Mail — 3-pane Gmail client over all connected Google accounts.
 * Route: #/mail/:view?/:threadId?/:threadAccountId?
 *   view = "all" (merged inboxes) or a Google account id; the 3rd segment carries the thread's account in "all" view.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GoogleAccount, MailThread, MailThreadSummary } from '@monarch/shared';
import { Inbox, Star, Send, FileText, Mail as MailIcon, Search, PenSquare, Archive as ArchiveIcon, CircleDot, RefreshCw } from 'lucide-preact';
import { api, qs } from '../lib/api.ts';
import { navigate, toast, useResource } from '../lib/store.ts';
import { Btn, Panel, Tag } from '../components/ui.tsx';
import { AccountMark, displayName, LoadError, Loading, StateBlock, shortStamp, useHotkeys } from '../components/mail/kit.tsx';
import { ThreadReader, type MailAction } from '../components/mail/reader.tsx';
import { ComposeModal } from '../components/mail/composer.tsx';

const LABELS: { id: string; name: string; label?: string; icon: typeof Inbox }[] = [
  { id: 'INBOX', name: 'Inbox', label: 'INBOX', icon: Inbox },
  { id: 'UNREAD', name: 'Unread', label: 'UNREAD', icon: CircleDot },
  { id: 'STARRED', name: 'Starred', label: 'STARRED', icon: Star },
  { id: 'SENT', name: 'Sent', label: 'SENT', icon: Send },
  { id: 'DRAFT', name: 'Drafts', label: 'DRAFT', icon: FileText },
  { id: 'ALL', name: 'All mail', label: 'ALL', icon: ArchiveIcon },
];

const enc = encodeURIComponent;

export default function MailPage(props: { params: string[] }) {
  const view = props.params[0] || 'all';
  const threadId = props.params[1] || null;

  const accRes = useResource<GoogleAccount[]>('/google/accounts', ['google']);
  const accounts = useMemo(() => (Array.isArray(accRes.data) ? accRes.data.filter((a) => a && typeof a.id === 'string') : []), [accRes.data]);

  const [labelId, setLabelId] = useState('INBOX');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyMode, setReplyMode] = useState<'reply' | 'all' | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const label = LABELS.find((l) => l.id === labelId)?.label;
  const accountFilter = view !== 'all' ? view : undefined;
  const listPath = accounts.length ? `/mail/threads${qs({ accountId: accountFilter, q, label, max: 40 })}` : null;
  const listRes = useResource<MailThreadSummary[]>(listPath, ['mail']);
  const threads = useMemo(
    () =>
      (Array.isArray(listRes.data) ? listRes.data.filter((t) => t && typeof t.id === 'string') : []).sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      ),
    [listRes.data],
  );

  const threadAcct = props.params[2] || (view !== 'all' ? view : threads.find((t) => t.id === threadId)?.accountId) || null;
  const threadRes = useResource<MailThread>(threadId && threadAcct ? `/mail/threads/${enc(threadAcct)}/${enc(threadId)}` : null, ['mail']);
  const openSummary = threads.find((t) => t.id === threadId && (!threadAcct || t.accountId === threadAcct));
  const threadLabels = useMemo(() => {
    const s = new Set<string>(openSummary?.labels ?? []);
    for (const m of threadRes.data?.messages ?? []) for (const l of m?.labels ?? []) s.add(l);
    return [...s];
  }, [openSummary, threadRes.data]);

  useEffect(() => setReplyMode(null), [threadId]);
  useEffect(() => setCursor(0), [view, labelId, q]);
  // keep the cursor on the open thread
  useEffect(() => {
    if (!threadId) return;
    const i = threads.findIndex((t) => t.id === threadId);
    if (i >= 0) setCursor(i);
  }, [threadId, threads]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const openThread = (t: MailThreadSummary) => navigate(`mail/${enc(view)}/${enc(t.id)}${view === 'all' ? `/${enc(t.accountId)}` : ''}`);
  const closeThread = () => navigate(`mail/${enc(view)}`);

  const unreadBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of threads) if (t.unread) m.set(t.accountId, (m.get(t.accountId) ?? 0) + 1);
    return m;
  }, [threads]);

  const modify = async (t: { id: string; accountId: string }, action: MailAction) => {
    const body =
      action === 'archive'
        ? { removeLabels: ['INBOX'] }
        : action === 'read'
          ? { removeLabels: ['UNREAD'] }
          : action === 'unread'
            ? { addLabels: ['UNREAD'] }
            : action === 'star'
              ? { addLabels: ['STARRED'] }
              : { removeLabels: ['STARRED'] };
    // optimistic list update
    const prev = listRes.data;
    if (prev) {
      listRes.setData(
        action === 'archive' && labelId === 'INBOX'
          ? prev.filter((x) => !(x.id === t.id && x.accountId === t.accountId))
          : prev.map((x) => {
              if (x.id !== t.id || x.accountId !== t.accountId) return x;
              const labels = new Set(x.labels ?? []);
              body.addLabels?.forEach((l) => labels.add(l));
              body.removeLabels?.forEach((l) => labels.delete(l));
              return { ...x, labels: [...labels], unread: labels.has('UNREAD') };
            }),
      );
    }
    if (action === 'archive' && threadId === t.id) {
      // advance to the next thread like a mail client
      const i = threads.findIndex((x) => x.id === t.id);
      const next = threads[i + 1] ?? threads[i - 1];
      if (next && next.id !== t.id) openThread(next);
      else closeThread();
    }
    try {
      await api.post(`/mail/threads/${enc(t.accountId)}/${enc(t.id)}/modify`, body);
      toast(
        { archive: 'Archived', read: 'Marked read', unread: 'Marked unread', star: 'Starred', unstar: 'Unstarred' }[action],
        'success',
      );
      void listRes.reload();
    } catch (e: any) {
      if (prev) listRes.setData(prev);
      toast(`Failed: ${e?.message ?? e}`, 'error');
    }
  };

  const cur = threads[cursor];
  const target = threadId && threadAcct ? { id: threadId, accountId: threadAcct } : cur ? { id: cur.id, accountId: cur.accountId } : null;
  const isStarred = (id: string) => (threadId === id ? threadLabels : (threads.find((t) => t.id === id)?.labels ?? [])).includes('STARRED');
  const isUnread = (id: string) => (threadId === id ? threadLabels.includes('UNREAD') : !!threads.find((t) => t.id === id)?.unread);

  useHotkeys(
    {
      j: () => setCursor((c) => Math.min(threads.length - 1, c + 1)),
      ArrowDown: () => setCursor((c) => Math.min(threads.length - 1, c + 1)),
      k: () => setCursor((c) => Math.max(0, c - 1)),
      ArrowUp: () => setCursor((c) => Math.max(0, c - 1)),
      Enter: () => cur && openThread(cur),
      o: () => cur && openThread(cur),
      Escape: () => (replyMode ? setReplyMode(null) : threadId && closeThread()),
      u: () => threadId && closeThread(),
      e: () => target && void modify(target, 'archive'),
      s: () => target && void modify(target, isStarred(target.id) ? 'unstar' : 'star'),
      m: () => target && void modify(target, isUnread(target.id) ? 'read' : 'unread'),
      r: () => threadId && setReplyMode('reply'),
      a: () => threadId && setReplyMode('all'),
      c: () => setComposeOpen(true),
      '/': () => searchRef.current?.focus(),
    },
    [threads, cursor, threadId, threadAcct, replyMode, threadLabels],
  );

  /* ─────────── top-level states ─────────── */

  if (accRes.data === undefined) {
    return (
      <div class="h-full p-3">
        <Panel code="MAIL.01" title="Mail" class="h-full">
          <div class="h-full flex items-center justify-center">{accRes.error ? <LoadError error={accRes.error} onRetry={accRes.reload} /> : <Loading label="Linking mailboxes" />}</div>
        </Panel>
      </div>
    );
  }
  if (!accounts.length) {
    return (
      <div class="h-full p-3">
        <Panel code="MAIL.01" title="Mail" class="h-full">
          <div class="h-full flex items-center justify-center">
            <StateBlock icon={<MailIcon size={28} strokeWidth={1} />} title="No Gmail accounts connected">
              <div>Connect one or more Google accounts and Monarch can read, triage, search and draft mail across all of them — here and from chat.</div>
              <div class="mt-4">
                <Btn variant="primary" onClick={() => navigate('config/accounts')}>
                  Connect an account
                </Btn>
              </div>
            </StateBlock>
          </div>
        </Panel>
      </div>
    );
  }

  const viewAccount = accounts.find((a) => a.id === view);
  const labelName = LABELS.find((l) => l.id === labelId)?.name ?? 'Inbox';

  return (
    <div class="h-full p-3 flex gap-3 min-h-0">
      {/* ── accounts + labels ── */}
      <Panel code="MAIL.01" title="Mailboxes" class="w-56 shrink-0" noPad bodyClass="flex flex-col overflow-y-auto">
        <div class="p-2.5 border-b border-line">
          <Btn variant="primary" class="w-full" onClick={() => setComposeOpen(true)} title="Compose (c)">
            <PenSquare size={12} /> Compose
          </Btn>
        </div>
        <div class="py-1.5">
          <div class="hud-label px-3 pt-1.5 pb-1">Accounts</div>
          <button class="hud-row w-full text-left" data-active={view === 'all'} onClick={() => navigate('mail/all')}>
            <span class="inline-grid grid-cols-2 gap-px w-1.5 h-1.5 shrink-0">
              {accounts.slice(0, 4).map((a) => (
                <AccountMark key={a.id} id={a.id} size={3} />
              ))}
            </span>
            <span class="truncate text-fg">All inboxes</span>
            {view === 'all' && labelId === 'INBOX' && !q && threads.some((t) => t.unread) && (
              <span class="ml-auto font-mono text-[10px] text-fg-2">{threads.filter((t) => t.unread).length}</span>
            )}
          </button>
          {accounts.map((a) => (
            <button key={a.id} class="hud-row w-full text-left" data-active={view === a.id} onClick={() => navigate(`mail/${enc(a.id)}`)} title={a.error ?? a.email}>
              <AccountMark id={a.id} />
              <span class="min-w-0 flex-1">
                <span class={`block truncate text-[13px] ${a.error ? 'text-fg-3' : 'text-fg-2'}`}>{a.label || a.name || a.email.split('@')[0]}</span>
                <span class="block truncate font-mono text-[10px] text-fg-3">{a.email}</span>
              </span>
              {a.error ? (
                <span class="font-mono text-[10px] text-red" title={a.error}>
                  ERR
                </span>
              ) : (
                (unreadBy.get(a.id) ?? 0) > 0 && labelId === 'INBOX' && !q && <span class="font-mono text-[10px] text-fg-2">{unreadBy.get(a.id)}</span>
              )}
            </button>
          ))}
        </div>
        <div class="py-1.5 border-t border-line">
          <div class="hud-label px-3 pt-1.5 pb-1">Labels</div>
          {LABELS.map((l) => {
            const Icon = l.icon;
            return (
              <button key={l.id} class="hud-row w-full text-left" data-active={labelId === l.id} onClick={() => setLabelId(l.id)}>
                <Icon size={13} strokeWidth={1.5} class="text-fg-3 shrink-0" />
                <span class="text-fg-2 text-[13px]">{l.name}</span>
              </button>
            );
          })}
        </div>
        <div class="mt-auto px-3 py-2 border-t border-line font-mono text-[10px] text-fg-3 leading-relaxed tracking-wider">
          J/K MOVE · ⏎ OPEN · E ARCH
          <br />S STAR · M READ · R REPLY
        </div>
      </Panel>

      {/* ── thread list ── */}
      <Panel
        code="MAIL.02"
        title={`${viewAccount ? viewAccount.label || viewAccount.email : 'All'} / ${labelName}`}
        class="w-[380px] xl:w-[420px] shrink-0"
        noPad
        bodyClass="flex flex-col"
        right={
          <button class="text-fg-3 hover:text-fg" title="Refresh" aria-label="Refresh" onClick={() => void listRes.reload()}>
            <RefreshCw size={12} class={listRes.loading ? 'animate-spin' : ''} />
          </button>
        }
      >
        <form
          class="p-2.5 border-b border-line"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(qInput.trim());
          }}
        >
          <label class="relative block">
            <Search size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
            <input
              ref={searchRef}
              class="hud-input py-1.5! pl-7! text-[13px]!"
              placeholder="Search · from:pepper is:unread newer_than:7d"
              value={qInput}
              onInput={(e) => setQInput((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQInput('');
                  setQ('');
                  (e.target as HTMLInputElement).blur();
                }
              }}
              aria-label="Search mail (Gmail syntax)"
            />
          </label>
          {q && (
            <div class="flex items-center gap-2 mt-2 font-mono text-[10px] text-fg-3 tracking-wider">
              QUERY <span class="text-fg-2 truncate">{q}</span>
              <button
                type="button"
                class="ml-auto hover:text-fg"
                onClick={() => {
                  setQ('');
                  setQInput('');
                }}
              >
                CLEAR
              </button>
            </div>
          )}
        </form>
        <div ref={listRef} class="flex-1 min-h-0 overflow-y-auto" role="listbox" aria-label="Threads">
          {listRes.error && !threads.length ? (
            <LoadError error={listRes.error} onRetry={listRes.reload} />
          ) : listRes.data === undefined ? (
            <Loading label="Fetching threads" />
          ) : !threads.length ? (
            <StateBlock title={q ? 'No results' : `${labelName} is empty`}>{q ? 'Try a broader Gmail query.' : 'Nothing here. Enjoy the quiet.'}</StateBlock>
          ) : (
            threads.map((t, i) => {
              const active = t.id === threadId;
              const starred = t.labels?.includes('STARRED');
              return (
                <button
                  key={`${t.accountId}:${t.id}`}
                  data-idx={i}
                  role="option"
                  aria-selected={active}
                  class={`w-full text-left px-3 py-2.5 border-b border-line/60 border-l-2 ${
                    active ? 'bg-subtle border-l-red' : i === cursor ? 'bg-white/[0.025] border-l-fg-3' : 'border-l-transparent hover:bg-white/[0.02]'
                  }`}
                  onClick={() => {
                    setCursor(i);
                    openThread(t);
                  }}
                >
                  <div class="flex items-center gap-2">
                    {t.unread ? <span class="w-1.5 h-1.5 bg-red shrink-0" title="Unread" /> : <span class="w-1.5 shrink-0" />}
                    <span class={`truncate text-[13px] ${t.unread ? 'text-fg font-semibold' : 'text-fg-2'}`}>{displayName(t.from) || '(unknown)'}</span>
                    {t.messageCount > 1 && <span class="font-mono text-[10px] text-fg-3">{t.messageCount}</span>}
                    {starred && <Star size={10} class="text-fg-2 shrink-0" fill="currentColor" />}
                    <span class="ml-auto flex items-center gap-1.5 shrink-0">
                      {view === 'all' && <AccountMark id={t.accountId} size={5} title={accounts.find((a) => a.id === t.accountId)?.email} />}
                      <span class={`font-mono text-[10px] ${t.unread ? 'text-fg-2' : 'text-fg-3'}`} title={t.date}>
                        {shortStamp(t.date)}
                      </span>
                    </span>
                  </div>
                  <div class={`pl-3.5 truncate text-[13px] mt-0.5 ${t.unread ? 'text-fg' : 'text-fg-2'}`}>{t.subject || '(no subject)'}</div>
                  <div class="pl-3.5 truncate text-xs text-fg-3 mt-0.5">{t.snippet}</div>
                </button>
              );
            })
          )}
        </div>
        <div class="px-3 py-1.5 border-t border-line font-mono text-[10px] tracking-widest uppercase text-fg-3 flex gap-3">
          <span>{threads.length} threads</span>
          {threads.some((t) => t.unread) && <span class="text-fg-2">{threads.filter((t) => t.unread).length} unread</span>}
        </div>
      </Panel>

      {/* ── reader ── */}
      <Panel code="MAIL.03" title="Thread" class="flex-1 min-w-0" noPad bodyClass="flex flex-col" right={threadId && threadRes.data ? <Tag>{threadRes.data.messages?.length ?? 0} msg</Tag> : undefined}>
        {threadId && threadAcct ? (
          <ThreadReader
            accountId={threadAcct}
            threadId={threadId}
            thread={threadRes.data && threadRes.data.id === threadId ? threadRes.data : undefined}
            loading={threadRes.loading}
            error={threadRes.error}
            reload={() => void threadRes.reload()}
            labels={threadLabels}
            accounts={accounts}
            onAction={(a) => void modify({ id: threadId, accountId: threadAcct }, a)}
            onClose={closeThread}
            replyMode={replyMode}
            setReplyMode={setReplyMode}
          />
        ) : threadId && listRes.data === undefined ? (
          <Loading label="Locating thread" />
        ) : (
          <div class="h-full flex items-center justify-center">
            <StateBlock icon={<MailIcon size={26} strokeWidth={1} />} title={threadId ? 'Thread not found' : 'No thread selected'}>
              {threadId ? 'It may have been archived or belongs to another account.' : 'Pick a thread, or press C to compose. Monarch can also summarize and draft replies for you.'}
            </StateBlock>
          </div>
        )}
      </Panel>

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} accounts={accounts} defaultAccount={view !== 'all' ? view : undefined} />
    </div>
  );
}
