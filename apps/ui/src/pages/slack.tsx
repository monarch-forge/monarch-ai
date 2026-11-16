/**
 * Slack — workspaces + channels (left), message log + composer (main), search, "Catch me up".
 * Route: #/slack/:workspaceId?/:channelId?
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SlackChannel, SlackMessage, SlackWorkspace } from '@monarch/shared';
import { Hash, Lock, MessageSquare, Users, Search, Sparkles, Send, X, RefreshCw, ExternalLink, MessagesSquare } from 'lucide-preact';
import { api, openExternal, qs } from '../lib/api.ts';
import { navigate, toast, useResource } from '../lib/store.ts';
import { Btn } from '../components/ui.tsx';
import { askMonarch, Button, LoadError, Loading, StateBlock, useConfirm, useHotkeys } from '../components/mail/kit.tsx';
import { mrkdwn } from '../components/slack/mrkdwn.ts';

const enc = encodeURIComponent;
const SLK_CLASS =
  'break-words text-[14px] leading-[1.6] text-fg/90 [&_a]:underline [&_a]:decoration-fg-3 [&_a]:underline-offset-2 [&_a:hover]:decoration-red [&_code]:font-mono [&_code]:text-[0.8em] [&_code]:bg-subtle [&_code]:px-1 [&_code]:rounded [&_pre]:bg-black/20 [&_pre]:rounded-md [&_pre]:p-2.5 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_.slk-mention]:text-fg [&_.slk-mention]:bg-subtle [&_.slk-mention]:px-1 [&_.slk-mention]:rounded [&_.slk-quote]:block [&_.slk-quote]:border-l-2 [&_.slk-quote]:border-subtle [&_.slk-quote]:pl-2 [&_.slk-quote]:text-fg-2 [&_del]:text-fg-3';

const GROUPS: { id: string; name: string; kinds: SlackChannel['kind'][] }[] = [
  { id: 'channel', name: 'Channels', kinds: ['channel'] },
  { id: 'private', name: 'Private', kinds: ['private'] },
  { id: 'dm', name: 'Direct messages', kinds: ['dm', 'group-dm'] },
];

function chanLabel(c: SlackChannel | undefined, fallback = ''): string {
  if (!c) return fallback;
  return c.kind === 'channel' || c.kind === 'private' ? `#${c.name}` : c.name;
}

function ChanIcon(props: { kind: SlackChannel['kind'] }) {
  const p = { size: 13, strokeWidth: 1.6, class: 'text-fg-3 shrink-0' };
  return props.kind === 'private' ? <Lock {...p} /> : props.kind === 'dm' ? <MessageSquare {...p} /> : props.kind === 'group-dm' ? <Users {...p} /> : <Hash {...p} />;
}

export default function SlackPage(props: { params: string[] }) {
  const wsRes = useResource<SlackWorkspace[]>('/slack/workspaces', ['slack']);
  const workspaces = useMemo(() => (Array.isArray(wsRes.data) ? wsRes.data.filter((w) => w && typeof w.id === 'string') : []), [wsRes.data]);
  const wsId = props.params[0] || workspaces[0]?.id || null;
  const channelId = props.params[1] || null;
  const ws = workspaces.find((w) => w.id === wsId);

  const chRes = useResource<SlackChannel[]>(wsId && ws ? `/slack/${enc(wsId)}/channels` : null, ['slack']);
  const channels = useMemo(() => (Array.isArray(chRes.data) ? chRes.data.filter((c) => c && typeof c.id === 'string') : []), [chRes.data]);
  const channel = channels.find((c) => c.id === channelId);

  const [filter, setFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setSearch('');
    setSearchInput('');
  }, [wsId]);

  const msgRes = useResource<SlackMessage[]>(wsId && channelId && ws ? `/slack/${enc(wsId)}/channels/${enc(channelId)}/messages?limit=60` : null, ['slack'], { intervalMs: 20000 });
  const searchRes = useResource<SlackMessage[]>(wsId && search ? `/slack/${enc(wsId)}/search${qs({ q: search })}` : null);

  const grouped = useMemo(() => {
    const f = filter.trim().toLowerCase().replace(/^#/, '');
    const match = channels.filter((c) => !f || c.name.toLowerCase().includes(f));
    const unread = match.filter((c) => (c.unread ?? 0) > 0).sort((a, b) => (b.unread ?? 0) - (a.unread ?? 0) || a.name.localeCompare(b.name));
    return [
      { id: 'unread', name: 'Unread', kinds: [] as SlackChannel['kind'][], items: unread },
      ...GROUPS.map((g) => ({
        ...g,
        items: match.filter((c) => g.kinds.includes(c.kind) && !(c.unread ?? 0)).sort((a, b) => a.name.localeCompare(b.name)),
      })),
    ].filter((g) => g.items.length);
  }, [channels, filter]);

  const flat = grouped.flatMap((g) => g.items);
  const go = (c: SlackChannel) => navigate(`slack/${enc(wsId!)}/${enc(c.id)}`);

  useHotkeys(
    {
      '/': () => searchRef.current?.focus(),
      f: () => filterRef.current?.focus(),
      j: () => {
        const i = flat.findIndex((c) => c.id === channelId);
        const n = flat[Math.min(flat.length - 1, i + 1)];
        if (n) go(n);
      },
      k: () => {
        const i = flat.findIndex((c) => c.id === channelId);
        const n = flat[Math.max(0, i - 1)];
        if (n) go(n);
      },
      i: () => composerRef.current?.focus(),
    },
    [flat, channelId, wsId],
  );

  /* ─────────── top-level states ─────────── */
  if (wsRes.data === undefined) {
    return (
      <div class="h-full flex items-center justify-center p-4">
        {wsRes.error ? <LoadError error={wsRes.error} onRetry={wsRes.reload} /> : <Loading label="Opening your workspaces" />}
      </div>
    );
  }
  if (!workspaces.length) {
    return (
      <div class="h-full flex items-center justify-center p-4">
        <StateBlock icon={<Hash size={30} strokeWidth={1.25} />} title="No Slack workspace yet">
          <div>Add a Slack token and Monarch can read channels, search history, post for you (after you approve) and send you gentle digests.</div>
          <div class="mt-5">
            <Btn variant="primary" onClick={() => navigate('config/accounts')}>
              Connect Slack
            </Btn>
          </div>
        </StateBlock>
      </div>
    );
  }

  return (
    <div class="h-full flex gap-4 min-h-0 p-3 sm:p-4 lg:p-5">
      {/* ── workspaces + channels ── */}
      <aside class={`${channelId || search ? 'hidden lg:flex' : 'flex'} w-full lg:w-60 shrink-0 flex-col min-h-0`}>
        {workspaces.length > 1 ? (
          <select
            class="w-full bg-subtle rounded-md text-[13.5px] font-medium text-fg px-2.5 py-2 outline-none"
            value={wsId ?? ''}
            onChange={(e) => navigate(`slack/${enc((e.target as HTMLSelectElement).value)}`)}
            aria-label="Workspace"
            title={ws?.error ?? (ws?.user ? `@${ws.user} · ${ws.tokenType}` : ws?.tokenType)}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.error ? ' (needs attention)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <div class="flex items-center gap-2.5 px-2 py-1" title={ws?.error ?? (ws?.user ? `@${ws.user} · ${ws.tokenType}` : ws?.tokenType)}>
            <span class="w-7 h-7 shrink-0 rounded-md bg-subtle grid place-items-center text-[12px] font-semibold text-fg-2">{(ws?.name || '?').slice(0, 1).toUpperCase()}</span>
            <span class="min-w-0">
              <span class="block truncate text-[14px] font-semibold text-fg">{ws?.name}</span>
              {ws?.user && <span class="block truncate text-[11.5px] text-fg-3">@{ws.user}</span>}
            </span>
          </div>
        )}
        {ws?.error && <div class="mt-2 px-2 text-[12px] text-red/90">{ws.error}</div>}
        <input
          ref={filterRef}
          class="mt-3 w-full bg-white/[0.04] rounded-md px-3 py-2 text-[13px] text-fg placeholder:text-fg-3 outline-none focus:bg-white/[0.06] transition-colors"
          placeholder="Jump to…"
          title="Filter channels (f)"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && flat[0]) {
              go(flat[0]);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setFilter('');
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Filter channels"
        />
        <div class="flex-1 min-h-0 overflow-y-auto pt-2">
          {chRes.error && !channels.length ? (
            <LoadError error={chRes.error} onRetry={chRes.reload} />
          ) : chRes.data === undefined ? (
            <Loading label="Listing channels" />
          ) : !grouped.length ? (
            <StateBlock title={filter ? 'No match' : 'No conversations'}>{filter ? `Nothing matches “${filter}”.` : 'This token can’t see any conversations.'}</StateBlock>
          ) : (
            grouped.map((g) => (
              <div key={g.id} class="mt-3 first:mt-1">
                <div class="px-3 pb-1 text-[11px] text-fg-3">{g.name}</div>
                {g.items.map((c) => {
                  const active = c.id === channelId;
                  return (
                    <button
                      key={c.id}
                      class={`relative w-full flex items-center gap-2.5 text-left px-3 py-1.5 rounded-md text-[13.5px] transition-colors ${
                        active ? 'bg-white/[0.06] text-fg' : 'hover:bg-raised'
                      }`}
                      onClick={() => go(c)}
                      title={c.topic || c.name}
                    >
                      {active && <span class="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-red" />}
                      <ChanIcon kind={c.kind} />
                      <span class={`truncate ${c.unread ? 'text-fg font-semibold' : active ? 'text-fg' : 'text-fg-2'}`}>{c.name}</span>
                      {!!c.unread && <span class="ml-auto font-mono text-[11px] text-fg-2">{c.unread > 99 ? '99+' : c.unread}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ── main ── */}
      <section class={`${channelId || search ? 'flex' : 'hidden lg:flex'} flex-1 min-w-0 flex-col min-h-0 bg-surface rounded-[10px] overflow-hidden`}>
        <header class="flex items-center gap-2 px-4 sm:px-5 pt-3.5 pb-2.5">
          {(channelId || search) && (
            <button class="lg:hidden -ml-1 p-1 rounded-md text-fg-3 hover:text-fg" aria-label="Back to channels" onClick={() => (search ? (setSearch(''), setSearchInput('')) : navigate(`slack/${enc(wsId!)}`))}>
              <X size={15} />
            </button>
          )}
          <div class="min-w-0 flex-1">
            <h1 class="text-[16px] font-semibold text-fg truncate">{search ? `Search: ${search}` : channel ? chanLabel(channel) : channelId ? channelId : ws?.name ?? 'Slack'}</h1>
            {!search && channel?.topic && <div class="text-[12.5px] text-fg-3 truncate">{channel.topic}</div>}
          </div>
          <form
            class="relative"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(searchInput.trim());
            }}
          >
            <Search size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
            <input
              ref={searchRef}
              class="w-28 sm:w-48 xl:w-60 bg-white/[0.04] rounded-md pl-8 pr-3 py-1.5 text-[13px] text-fg placeholder:text-fg-3 outline-none focus:bg-white/[0.06] transition-colors"
              placeholder="Search"
              title={`Search ${ws?.name ?? ''} (/)`}
              value={searchInput}
              onInput={(e) => setSearchInput((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearch('');
                  setSearchInput('');
                  (e.target as HTMLInputElement).blur();
                }
              }}
              aria-label="Search messages"
            />
          </form>
          {channelId && !search && (
            <>
              <button class="p-1.5 rounded-md text-fg-3 hover:text-fg hover:bg-subtle transition-colors" title="Refresh (auto every 20s)" aria-label="Refresh" onClick={() => void msgRes.reload()}>
                <RefreshCw size={13} class={msgRes.loading ? 'animate-spin' : ''} />
              </button>
              <button
                class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[12.5px] text-fg-3 hover:text-fg hover:bg-subtle transition-colors"
                title="Ask Monarch to summarize this channel"
                onClick={() =>
                  askMonarch(
                    `Summarize the latest activity in ${chanLabel(channel, channelId)} (Slack workspace "${ws?.name ?? wsId}", workspaceId ${wsId}, channelId ${channelId}) and flag anything needing my attention.`,
                  )
                }
              >
                <Sparkles size={13} /> <span class="hidden md:inline">Catch me up</span>
              </button>
            </>
          )}
        </header>
        {search ? (
          <SearchResults
            q={search}
            res={searchRes}
            channels={channels}
            onClose={() => {
              setSearch('');
              setSearchInput('');
            }}
            onOpen={(m) => {
              setSearch('');
              setSearchInput('');
              navigate(`slack/${enc(m.workspaceId || wsId!)}/${enc(m.channelId)}`);
            }}
          />
        ) : !channelId ? (
          <div class="flex-1 flex items-center justify-center">
            <StateBlock icon={<MessagesSquare size={28} strokeWidth={1.25} />} title="Pick a conversation">
              Choose a channel or DM on the left (j / k to step through), or press / to search everything.
              {ws && (
                <div class="mt-4">
                  <Btn size="xs" onClick={() => askMonarch(`Give me a digest of what happened today across my Slack workspace "${ws.name}" (workspaceId ${ws.id}). Flag mentions, questions directed at me and anything urgent.`)}>
                    <Sparkles size={12} /> Workspace digest
                  </Btn>
                </div>
              )}
            </StateBlock>
          </div>
        ) : (
          <>
            <MessageLog res={msgRes} key={`${wsId}:${channelId}`} />
            <SlackComposer
              wsId={wsId!}
              wsName={ws?.name ?? wsId!}
              channelId={channelId}
              label={chanLabel(channel, channelId)}
              inputRef={composerRef}
              onPosted={(m) => {
                if (m && typeof m === 'object' && msgRes.data) msgRes.setData([...msgRes.data, m]);
                void msgRes.reload();
              }}
            />
          </>
        )}
      </section>
    </div>
  );
}

/* ───────────────────────── message log ───────────────────────── */

function useUserMap(msgs: SlackMessage[]): Map<string, string> {
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const x of msgs) if (x.userId && x.user && x.user !== x.userId) m.set(x.userId, x.user);
    return m;
  }, [msgs]);
}

function sortMsgs(list: SlackMessage[] | undefined): SlackMessage[] {
  return (Array.isArray(list) ? list.filter((m) => m && typeof m.ts === 'string') : []).sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
}

function msgDate(m: SlackMessage): Date {
  const d = m.date ? new Date(m.date) : new Date(parseFloat(m.ts) * 1000);
  return isNaN(d.getTime()) ? new Date(parseFloat(m.ts) * 1000) : d;
}

function MessageLog(props: { res: { data: SlackMessage[] | undefined; error?: string; loading: boolean; reload: () => Promise<void> } }) {
  const msgs = useMemo(() => sortMsgs(props.res.data), [props.res.data]);
  const users = useUserMap(msgs);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTs = msgs[msgs.length - 1]?.ts;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastTs, msgs.length]);

  if (props.res.error && !msgs.length) return <div class="flex-1 flex items-center justify-center"><LoadError error={props.res.error} onRetry={props.res.reload} /></div>;
  if (props.res.data === undefined) return <div class="flex-1"><Loading label="Loading history" /></div>;
  if (!msgs.length) return <div class="flex-1 flex items-center justify-center"><StateBlock title="No messages yet">Be the first to say something.</StateBlock></div>;

  let lastDay = '';
  let lastUser = '';
  let lastTime = 0;
  return (
    <div
      ref={ref}
      class="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 pb-4"
      onScroll={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      onClick={onExternalClick}
    >
      {msgs.map((m) => {
        const d = msgDate(m);
        const day = d.toDateString();
        const showDay = day !== lastDay;
        const grouped = !showDay && lastUser === (m.userId ?? m.user) && d.getTime() - lastTime < 5 * 60000;
        lastDay = day;
        lastUser = m.userId ?? m.user;
        lastTime = d.getTime();
        return (
          <div key={m.ts}>
            {showDay && (
              <div class="flex justify-center mt-5 mb-2">
                <span class="text-[11.5px] text-fg-3 bg-white/[0.03] rounded-full px-3 py-0.5">{d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</span>
              </div>
            )}
            <div class={`group flex gap-3 px-2 py-0.5 rounded-md hover:bg-white/[0.02] transition-colors ${grouped ? '' : 'mt-3'}`}>
              <span class="w-8 shrink-0 pt-0.5">
                {grouped ? (
                  <span class="block font-mono text-[10px] text-fg-3 pt-[3px] opacity-0 group-hover:opacity-100 tabular-nums">{fmtTime(d)}</span>
                ) : (
                  <span class="w-8 h-8 rounded-full bg-subtle grid place-items-center text-[12px] font-semibold text-fg-2">{(m.user || m.userId || '?').slice(0, 1).toUpperCase()}</span>
                )}
              </span>
              <div class="min-w-0 flex-1">
                {!grouped && (
                  <div class="flex items-baseline gap-2 mb-0.5">
                    <span class="text-[13.5px] font-semibold text-fg">{m.user || m.userId || 'unknown'}</span>
                    <span class="font-mono text-[11px] text-fg-3 tabular-nums" title={d.toLocaleString()}>
                      {fmtTime(d)}
                    </span>
                  </div>
                )}
                <div class={SLK_CLASS} dangerouslySetInnerHTML={{ __html: mrkdwn(m.text ?? '', users) }} />
                {(!!m.replyCount || m.permalink) && (
                  <div class="flex items-center gap-3 mt-1 text-[12px] text-fg-3">
                    {!!m.replyCount && (
                      <span class="text-fg-2">
                        {m.replyCount} repl{m.replyCount === 1 ? 'y' : 'ies'}
                      </span>
                    )}
                    {m.permalink && (
                      <button class="opacity-0 group-hover:opacity-100 hover:text-fg inline-flex items-center gap-1" onClick={() => void openExternal(m.permalink!)}>
                        <ExternalLink size={10} /> open in Slack
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function onExternalClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('[data-external]') as HTMLElement | null;
  if (!a) return;
  e.preventDefault();
  void openExternal(a.dataset.external!);
}

/* ───────────────────────── search ───────────────────────── */

function SearchResults(props: {
  q: string;
  res: { data: SlackMessage[] | undefined; error?: string; loading: boolean; reload: () => Promise<void> };
  channels: SlackChannel[];
  onClose: () => void;
  onOpen: (m: SlackMessage) => void;
}) {
  const list = useMemo(() => (Array.isArray(props.res.data) ? props.res.data.filter((m) => m && m.ts) : []), [props.res.data]);
  const users = useUserMap(list);
  return (
    <div class="flex-1 min-h-0 flex flex-col">
      <div class="flex items-center gap-2 px-5 pb-2 text-[12.5px] text-fg-3">
        <span>{props.res.data === undefined ? 'Searching…' : `${list.length} result${list.length === 1 ? '' : 's'}`}</span>
        <button class="ml-auto inline-flex items-center gap-1 hover:text-fg" onClick={props.onClose}>
          <X size={12} /> Back to channel
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-3" onClick={onExternalClick}>
        {props.res.error ? (
          <LoadError error={props.res.error} onRetry={props.res.reload} />
        ) : props.res.data === undefined ? (
          <Loading label="Searching" />
        ) : !list.length ? (
          <StateBlock title="No results">Slack search syntax works too: in:#general from:@pepper before:2026-11-01</StateBlock>
        ) : (
          list.map((m) => {
            const c = props.channels.find((x) => x.id === m.channelId);
            return (
              <div key={`${m.channelId}:${m.ts}`} class="px-3 py-3 rounded-md hover:bg-raised transition-colors">
                <div class="flex items-center gap-2 text-[12px] text-fg-3">
                  <button class="text-fg-2 hover:text-fg" onClick={() => props.onOpen(m)} title="Open channel">
                    {chanLabel(c, m.channelId)}
                  </button>
                  <span>·</span>
                  <span class="text-fg-2">{m.user || m.userId}</span>
                  <span class="ml-auto font-mono text-[11px]">{msgDate(m).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                </div>
                <div class={`${SLK_CLASS} mt-1 line-clamp-4`} dangerouslySetInnerHTML={{ __html: mrkdwn(m.text ?? '', users) }} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── composer ───────────────────────── */

function SlackComposer(props: {
  wsId: string;
  wsName: string;
  channelId: string;
  label: string;
  inputRef: { current: HTMLTextAreaElement | null };
  onPosted: (m: SlackMessage | null) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, confirm] = useConfirm();
  // drafts per channel survive switching channels within the session
  const drafts = useRef(new Map<string, string>());
  const prevChan = useRef(props.channelId);
  useEffect(() => {
    drafts.current.set(prevChan.current, text);
    setText(drafts.current.get(props.channelId) ?? '');
    prevChan.current = props.channelId;
  }, [props.channelId]);

  const post = async () => {
    const t = text.trim();
    if (!t || busy) return;
    const ok = await confirm({
      title: 'Post to Slack',
      confirmLabel: 'Post',
      body: (
        <div>
          <div class="mb-2">
            Post as you to <span class="text-fg font-mono">{props.label}</span> in <span class="text-fg">{props.wsName}</span>:
          </div>
          <div class={`${SLK_CLASS} rounded-md bg-white/[0.04] p-3 max-h-60 overflow-y-auto`} dangerouslySetInnerHTML={{ __html: mrkdwn(t) }} />
        </div>
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const m = await api.post<SlackMessage>(`/slack/${enc(props.wsId)}/post`, { channelId: props.channelId, text: t });
      setText('');
      drafts.current.delete(props.channelId);
      props.onPosted(m && typeof m === 'object' && 'ts' in m ? m : null);
      toast(`Posted to ${props.label}`, 'success');
    } catch (e: any) {
      toast(`Post failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
      props.inputRef.current?.focus();
    }
  };

  return (
    <div class="px-3 sm:px-4 pb-3 sm:pb-4">
      <div class="flex items-end gap-2 rounded-[10px] bg-white/[0.04] focus-within:bg-white/[0.06] transition-colors">
        <textarea
          ref={(el) => {
            props.inputRef.current = el;
          }}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          class="flex-1 bg-transparent outline-none resize-none px-3.5 py-2.5 text-[14px] leading-relaxed text-fg placeholder:text-fg-3"
          placeholder={`Message ${props.label}`}
          title="Enter to post · Shift+Enter for a new line"
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              void post();
            } else if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
          }}
          aria-label={`Message ${props.label}`}
        />
        <Button variant="primary" size="xs" class="m-1.5" loading={busy} disabled={!text.trim()} onClick={() => void post()} title="Post (Enter)">
          <Send size={12} />
        </Button>
      </div>
      {dialog}
    </div>
  );
}
