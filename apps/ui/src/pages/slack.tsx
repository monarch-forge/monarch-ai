/**
 * Slack — workspaces + channels (left), message log + composer (main), search, "Catch me up".
 * Route: #/slack/:workspaceId?/:channelId?
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SlackChannel, SlackMessage, SlackWorkspace } from '@monarch/shared';
import { Hash, Lock, MessageSquare, Users, Search, Sparkles, Send, X, RefreshCw, ExternalLink, MessagesSquare } from 'lucide-preact';
import { api, openExternal, qs } from '../lib/api.ts';
import { navigate, toast, useResource } from '../lib/store.ts';
import { Btn, Panel, Tag } from '../components/ui.tsx';
import { askMonarch, Button, LoadError, Loading, StateBlock, useConfirm, useHotkeys } from '../components/mail/kit.tsx';
import { mrkdwn } from '../components/slack/mrkdwn.ts';

const enc = encodeURIComponent;
const SLK_CLASS =
  'break-words text-[13px] leading-relaxed text-fg/90 [&_a]:underline [&_a]:decoration-fg-3 [&_a]:underline-offset-2 [&_a:hover]:decoration-red [&_code]:font-mono [&_code]:text-[0.8em] [&_code]:bg-subtle [&_code]:px-1 [&_pre]:bg-[#121213] [&_pre]:border [&_pre]:border-line [&_pre]:p-2 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_.slk-mention]:text-fg [&_.slk-mention]:bg-subtle [&_.slk-mention]:px-0.5 [&_.slk-quote]:block [&_.slk-quote]:border-l-2 [&_.slk-quote]:border-line [&_.slk-quote]:pl-2 [&_.slk-quote]:text-fg-2 [&_del]:text-fg-3';

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
  const p = { size: 12, strokeWidth: 1.5, class: 'text-fg-3 shrink-0' };
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
    return GROUPS.map((g) => ({
      ...g,
      items: channels
        .filter((c) => g.kinds.includes(c.kind) && (!f || c.name.toLowerCase().includes(f)))
        .sort((a, b) => (b.unread ?? 0) - (a.unread ?? 0) || a.name.localeCompare(b.name)),
    })).filter((g) => g.items.length);
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
      <div class="h-full p-3">
        <Panel code="SLK.01" title="Slack" class="h-full">
          <div class="h-full flex items-center justify-center">{wsRes.error ? <LoadError error={wsRes.error} onRetry={wsRes.reload} /> : <Loading label="Linking workspaces" />}</div>
        </Panel>
      </div>
    );
  }
  if (!workspaces.length) {
    return (
      <div class="h-full p-3">
        <Panel code="SLK.01" title="Slack" class="h-full">
          <div class="h-full flex items-center justify-center">
            <StateBlock icon={<Hash size={28} strokeWidth={1} />} title="No Slack workspace connected">
              <div>Add a Slack user or bot token and Monarch can read channels, search history, post on your behalf (with approval) and send you digests.</div>
              <div class="mt-4">
                <Btn variant="primary" onClick={() => navigate('config/accounts')}>
                  Connect Slack
                </Btn>
              </div>
            </StateBlock>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div class="h-full p-3 flex gap-3 min-h-0">
      {/* ── workspaces + channels ── */}
      <Panel code="SLK.01" title="Workspaces" class="w-64 shrink-0" noPad bodyClass="flex flex-col min-h-0">
        <div class="py-1.5 border-b border-line">
          {workspaces.map((w) => (
            <button key={w.id} class="hud-row w-full text-left" data-active={w.id === wsId} onClick={() => navigate(`slack/${enc(w.id)}`)} title={w.error ?? w.name}>
              <span class="w-5 h-5 shrink-0 border border-line grid place-items-center font-mono text-[10px] text-fg-2">{(w.name || '?').slice(0, 1).toUpperCase()}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px] text-fg">{w.name}</span>
                <span class="block truncate font-mono text-[10px] text-fg-3">
                  {w.user ? `@${w.user}` : ''} · {w.tokenType}
                </span>
              </span>
              {w.error && (
                <span class="font-mono text-[10px] text-red" title={w.error}>
                  ERR
                </span>
              )}
            </button>
          ))}
        </div>
        <div class="p-2.5 border-b border-line">
          <input
            ref={filterRef}
            class="hud-input py-1.5! text-[13px]!"
            placeholder="Filter channels (f)"
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
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto py-1">
          {chRes.error && !channels.length ? (
            <LoadError error={chRes.error} onRetry={chRes.reload} />
          ) : chRes.data === undefined ? (
            <Loading label="Listing channels" />
          ) : !grouped.length ? (
            <StateBlock title={filter ? 'No match' : 'No channels'}>{filter ? `Nothing matches “${filter}”.` : 'This token cannot see any conversations.'}</StateBlock>
          ) : (
            grouped.map((g) => (
              <div key={g.id} class="mb-1">
                <div class="hud-label px-3 pt-2 pb-1 flex">
                  {g.name}
                  <span class="ml-auto">{g.items.length}</span>
                </div>
                {g.items.map((c) => (
                  <button key={c.id} class="hud-row w-full text-left py-1!" data-active={c.id === channelId} onClick={() => go(c)} title={c.topic || c.name}>
                    <ChanIcon kind={c.kind} />
                    <span class={`truncate text-[13px] ${c.unread ? 'text-fg font-medium' : 'text-fg-2'}`}>{c.name}</span>
                    {!!c.unread && <span class="ml-auto font-mono text-[10px] bg-red text-fg px-1 leading-4">{c.unread > 99 ? '99+' : c.unread}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </Panel>

      {/* ── main ── */}
      <Panel
        code="SLK.02"
        title={search ? `Search · ${search}` : channel ? chanLabel(channel) : channelId ? channelId : ws?.name ?? 'Slack'}
        class="flex-1 min-w-0"
        noPad
        bodyClass="flex flex-col min-h-0"
        right={
          <>
            <form
              class="relative"
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(searchInput.trim());
              }}
            >
              <Search size={11} class="absolute left-2 top-1/2 -translate-y-1/2 text-fg-3" />
              <input
                ref={searchRef}
                class="hud-input py-1! pl-6! text-xs! w-56"
                placeholder={`Search ${ws?.name ?? ''} (/)`}
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
                <button class="text-fg-3 hover:text-fg p-1" title="Refresh (auto every 20s)" aria-label="Refresh" onClick={() => void msgRes.reload()}>
                  <RefreshCw size={12} class={msgRes.loading ? 'animate-spin' : ''} />
                </button>
                <Btn
                  size="xs"
                  title="Ask Monarch to summarize this channel"
                  onClick={() =>
                    askMonarch(
                      `Summarize the latest activity in ${chanLabel(channel, channelId)} (Slack workspace "${ws?.name ?? wsId}", workspaceId ${wsId}, channelId ${channelId}) and flag anything needing my attention.`,
                    )
                  }
                >
                  <Sparkles size={12} /> Catch me up
                </Btn>
              </>
            )}
          </>
        }
      >
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
            <StateBlock icon={<MessagesSquare size={26} strokeWidth={1} />} title="Pick a conversation">
              Choose a channel or DM on the left (J/K to step through), or search the whole workspace with “/”.
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
            {channel?.topic && <div class="px-4 py-1.5 border-b border-line text-xs text-fg-3 truncate">{channel.topic}</div>}
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
      </Panel>
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
      class="flex-1 min-h-0 overflow-y-auto px-4 py-3"
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
              <div class="flex items-center gap-3 my-3">
                <span class="flex-1 h-px bg-line" />
                <span class="hud-label">{d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                <span class="flex-1 h-px bg-line" />
              </div>
            )}
            <div class={`group flex gap-3 px-1 hover:bg-white/[0.015] ${grouped ? 'pt-0.5' : 'pt-2.5'}`}>
              <span class="w-11 shrink-0 font-mono text-[10px] text-fg-3 pt-[3px] tabular-nums" title={d.toLocaleString()}>
                {grouped ? <span class="opacity-0 group-hover:opacity-100">{fmtTime(d)}</span> : fmtTime(d)}
              </span>
              <div class="min-w-0 flex-1">
                {!grouped && <div class="font-mono text-[12px] text-fg-2 mb-0.5">{m.user || m.userId || 'unknown'}</div>}
                <div class={SLK_CLASS} dangerouslySetInnerHTML={{ __html: mrkdwn(m.text ?? '', users) }} />
                {(!!m.replyCount || m.permalink) && (
                  <div class="flex items-center gap-3 mt-1 font-mono text-[10px] text-fg-3">
                    {!!m.replyCount && (
                      <span>
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
      <div class="flex items-center gap-2 px-4 py-2 border-b border-line">
        <span class="hud-label">Results</span>
        <Tag>{props.res.data === undefined ? '…' : list.length}</Tag>
        <button class="ml-auto inline-flex items-center gap-1 font-mono text-[10px] tracking-widest uppercase text-fg-3 hover:text-fg" onClick={props.onClose}>
          <X size={12} /> Back to channel
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto" onClick={onExternalClick}>
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
              <div key={`${m.channelId}:${m.ts}`} class="px-4 py-2.5 border-b border-line/60 hover:bg-white/[0.02]">
                <div class="flex items-center gap-2 font-mono text-[10px] text-fg-3">
                  <button class="text-fg-2 hover:text-fg" onClick={() => props.onOpen(m)} title="Open channel">
                    {chanLabel(c, m.channelId)}
                  </button>
                  <span>·</span>
                  <span class="text-fg-2">{m.user || m.userId}</span>
                  <span class="ml-auto">{msgDate(m).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
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
          <div class={`${SLK_CLASS} border border-line bg-[#121213] p-2.5 max-h-60 overflow-y-auto`} dangerouslySetInnerHTML={{ __html: mrkdwn(t) }} />
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
    <div class="border-t border-line p-2.5">
      <div class="flex items-end gap-2 border border-line bg-[#121213] focus-within:border-fg-3">
        <textarea
          ref={(el) => {
            props.inputRef.current = el;
          }}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          class="flex-1 bg-transparent outline-none resize-none px-3 py-2 text-[13px] leading-relaxed text-fg placeholder:text-fg-3"
          placeholder={`Message ${props.label}  ·  Enter to post, Shift+Enter newline`}
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
