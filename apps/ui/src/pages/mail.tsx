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
import { Btn, ListRow } from '../components/ui.tsx';
import { AccountMark, askMonarch, displayName, LoadError, Loading, RefreshHint, StateBlock, shortStamp, useHotkeys } from '../components/mail/kit.tsx';
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
      <div class="h-full flex items-center justify-center p-4">
        {accRes.error ? <LoadError error={accRes.error} onRetry={accRes.reload} /> : <Loading label="Opening your mailboxes" />}
      </div>
    );
  }
  if (!accounts.length) {
    return (
      <div class="h-full flex items-center justify-center p-4">
        <StateBlock
          icon={<MailIcon size={18} strokeWidth={1.5} />}
          title="No mail connected yet"
          actions={
            <Btn variant="primary" onClick={() => navigate('config/accounts')}>
              Connect Gmail
            </Btn>
          }
        >
          Connect a Google account and Monarch can read, sort, search and draft mail with you — here and from chat.
        </StateBlock>
      </div>
    );
  }

  const viewAccount = accounts.find((a) => a.id === view);
  const labelName = LABELS.find((l) => l.id === labelId)?.name ?? 'Inbox';
  const unreadCount = threads.filter((t) => t.unread).length;
  const navRow = (active: boolean) =>
    `relative w-full flex items-center gap-2.5 text-left px-3 py-2 rounded-[var(--radius-control)] text-[13.5px] transition-colors ${
      active ? 'bg-white/[0.05] text-fg' : 'text-fg-2 hover:bg-raised hover:text-fg'
    }`;

  return (
    <div class="h-full flex gap-4 min-h-0 p-3 sm:p-4 lg:p-5">
      {/* ── mailboxes (quiet sidebar, lg+) ── */}
      <aside class="hidden lg:flex w-52 shrink-0 flex-col min-h-0 overflow-y-auto">
        <Btn variant="primary" class="w-full mb-5" onClick={() => setComposeOpen(true)} title="Compose (c)">
          <PenSquare size={13} /> Compose
        </Btn>
        <div class="px-3 pb-1.5 text-[11px] text-fg-3">Accounts</div>
        <button class={navRow(view === 'all')} onClick={() => navigate('mail/all')}>
          <span class="inline-grid grid-cols-2 gap-[2px] w-2 h-2 shrink-0">
            {accounts.slice(0, 4).map((a) => (
              <AccountMark key={a.id} id={a.id} size={3} />
            ))}
          </span>
          <span class="truncate">All inboxes</span>
          {view === 'all' && labelId === 'INBOX' && !q && unreadCount > 0 && <span class="ml-auto font-mono text-[11px] text-fg-3">{unreadCount}</span>}
        </button>
        {accounts.map((a) => (
          <button key={a.id} class={navRow(view === a.id)} onClick={() => navigate(`mail/${enc(a.id)}`)} title={a.error ?? a.email}>
            <AccountMark id={a.id} size={7} />
            <span class={`truncate ${a.error ? 'text-fg-3' : ''}`}>{a.label || a.name || a.email.split('@')[0]}</span>
            {a.error ? (
              <span class="ml-auto w-1.5 h-1.5 rounded-full bg-red shrink-0" title={a.error} aria-label="Account error" />
            ) : (
              (unreadBy.get(a.id) ?? 0) > 0 && labelId === 'INBOX' && !q && <span class="ml-auto font-mono text-[11px] text-fg-3">{unreadBy.get(a.id)}</span>
            )}
          </button>
        ))}
        <div class="px-3 pt-6 pb-1.5 text-[11px] text-fg-3">Folders</div>
        {LABELS.map((l) => {
          const Icon = l.icon;
          return (
            <button key={l.id} class={navRow(labelId === l.id)} onClick={() => setLabelId(l.id)}>
              <Icon size={14} strokeWidth={1.6} class="text-fg-3 shrink-0" />
              <span>{l.name}</span>
            </button>
          );
        })}
        <div class="mt-auto pt-6 px-3 text-[11px] text-fg-3/80 leading-relaxed" title="j/k move · Enter open · e archive · s star · m read/unread · r reply · a reply all · c compose · / search">
          Tip: j / k to move, e to archive, r to reply.
        </div>
      </aside>

      {/* ── thread list ── */}
      <section class={`${threadId ? 'hidden lg:flex' : 'flex'} flex-col min-h-0 w-full lg:w-[360px] xl:w-[400px] shrink-0 bg-surface rounded-[var(--radius-card)] overflow-hidden`}>
        {/* narrow-screen mailbox switcher */}
        <div class="lg:hidden flex items-center gap-2 px-3 pt-3">
          <select
            class="flex-1 min-w-0 bg-subtle rounded-[var(--radius-control)] text-[13px] text-fg px-2 py-1.5 outline-none"
            value={view}
            onChange={(e) => navigate(`mail/${enc((e.target as HTMLSelectElement).value)}`)}
            aria-label="Mailbox"
          >
            <option value="all">All inboxes</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label || a.name || a.email}
              </option>
            ))}
          </select>
          <select
            class="bg-subtle rounded-[var(--radius-control)] text-[13px] text-fg px-2 py-1.5 outline-none"
            value={labelId}
            onChange={(e) => setLabelId((e.target as HTMLSelectElement).value)}
            aria-label="Folder"
          >
            {LABELS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <Btn variant="primary" size="sm" onClick={() => setComposeOpen(true)} title="Compose (c)" aria-label="Compose">
            <PenSquare size={13} />
          </Btn>
        </div>
        <div class="flex items-baseline gap-2 px-4 pt-4 pb-2">
          <h1 class="text-[16px] font-semibold text-fg truncate">{labelName}</h1>
          <span class="text-[12.5px] text-fg-3 truncate">{viewAccount ? viewAccount.label || viewAccount.email : 'all inboxes'}</span>
          <RefreshHint res={listRes} class="self-center" />
          <Btn variant="ghost" size="xs" class="ml-auto btn-square" title="Refresh" aria-label="Refresh" onClick={() => void listRes.reload()}>
            <RefreshCw size={13} class={listRes.loading ? 'animate-spin' : ''} />
          </Btn>
        </div>
        <form
          class="px-3 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(qInput.trim());
          }}
        >
          <label class="relative block">
            <Search size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
            <input
              ref={searchRef}
              class="w-full bg-white/[0.04] rounded-[var(--radius-control)] pl-8 pr-3 py-2 text-[13px] text-fg placeholder:text-fg-3 outline-none focus:bg-white/[0.06] transition-colors"
              placeholder="Search mail"
              title="Gmail search syntax works: from:pepper is:unread newer_than:7d"
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
            <div class="flex items-center gap-2 mt-2 px-1 text-[12px] text-fg-3">
              Results for <span class="text-fg-2 truncate">“{q}”</span>
              <Btn
                type="button"
                variant="ghost"
                size="xs"
                class="ml-auto"
                onClick={() => {
                  setQ('');
                  setQInput('');
                }}
              >
                Clear
              </Btn>
            </div>
          )}
        </form>
        <div ref={listRef} class="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2" role="listbox" aria-label="Threads">
          {listRes.error && !threads.length ? (
            <LoadError error={listRes.error} onRetry={listRes.reload} />
          ) : listRes.data === undefined ? (
            <Loading label="Fetching mail" />
          ) : !threads.length ? (
            <StateBlock
              icon={q ? <Search size={18} strokeWidth={1.5} /> : <Inbox size={18} strokeWidth={1.5} />}
              title={q ? 'Nothing matches that search' : 'All clear'}
              actions={
                q ? (
                  <Btn onClick={() => { setQ(''); setQInput(''); }}>Clear search</Btn>
                ) : (
                  <>
                    <Btn onClick={() => void listRes.reload()}>Check again</Btn>
                    <Btn variant="ghost" onClick={() => askMonarch('Summarise what needs my attention in my email today.')}>Ask Monarch</Btn>
                  </>
                )
              }
            >
              {q ? 'Try fewer or broader words.' : `${labelName} is empty. Enjoy the quiet.`}
            </StateBlock>
          ) : (
            threads.map((t, i) => {
              const active = t.id === threadId;
              const starred = t.labels?.includes('STARRED');
              return (
                <ListRow
                  key={`${t.accountId}:${t.id}`}
                  attrs={{ 'data-idx': i, role: 'option', 'aria-selected': active }}
                  active={active}
                  focused={i === cursor}
                  marker
                  class="py-3"
                  onClick={() => {
                    setCursor(i);
                    openThread(t);
                  }}
                  title={
                    <span class="flex items-center gap-2">
                      {view === 'all' && <AccountMark id={t.accountId} size={6} title={accounts.find((a) => a.id === t.accountId)?.email} />}
                      <span class={`truncate ${t.unread ? 'text-fg font-semibold' : 'text-fg-2'}`}>{displayName(t.from) || '(unknown)'}</span>
                      {t.messageCount > 1 && <span class="font-mono text-[11px] text-fg-3">{t.messageCount}</span>}
                      {starred && <Star size={11} class="text-warning/80 shrink-0" fill="currentColor" />}
                      <span class={`ml-auto shrink-0 font-mono text-[11px] ${t.unread ? 'text-fg-2' : 'text-fg-3'}`} title={t.date}>
                        {shortStamp(t.date)}
                      </span>
                    </span>
                  }
                  sub={
                    <>
                      <span class={`block truncate text-[13px] ${t.unread ? 'text-fg font-medium' : 'text-fg-2'}`}>{t.subject || '(no subject)'}</span>
                      <span class="block truncate text-[12.5px] text-fg-3 mt-0.5">{t.snippet}</span>
                    </>
                  }
                />
              );
            })
          )}
        </div>
      </section>

      {/* ── reader ── */}
      <section class={`${threadId ? 'flex' : 'hidden lg:flex'} flex-1 min-w-0 flex-col min-h-0 bg-surface rounded-[var(--radius-card)] overflow-hidden`}>
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
          <Loading label="Finding that conversation" />
        ) : (
          <div class="h-full flex items-center justify-center">
            <StateBlock icon={<MailIcon size={28} strokeWidth={1.25} />} title={threadId ? 'Couldn’t find that conversation' : 'Pick a conversation to read'}>
              {threadId ? 'It may have been archived, or it lives in another account.' : 'Or press C to write something new. Monarch can also summarize threads and draft replies.'}
            </StateBlock>
          </div>
        )}
      </section>

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} accounts={accounts} defaultAccount={view !== 'all' ? view : undefined} />
    </div>
  );
}
