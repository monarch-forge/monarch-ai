/**
 * COMMS — conversations with Monarch (route #/comms/:id?, "#/comms/new" = blank session). UI-B.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { SessionKind } from '@monarch/shared';
import { Plus, Search, MessageSquare, Zap } from 'lucide-preact';
import { Panel, Tag, Empty, Spinner, ErrorLine } from '../components/ui.tsx';
import { Transcript } from '../components/chat/transcript.tsx';
import { Composer, focusComposer, type SlashCommand } from '../components/chat/composer.tsx';
import { SessionRow, Segmented } from '../components/chat/session-list.tsx';
import { SessionStats, engineLabel } from '../components/chat/meta.tsx';
import { useChatSession, useSessions, renameSession, totalTokens } from '../lib/chat-store.ts';
import { conn, navigate, settings, toast } from '../lib/store.ts';
import { fmt } from '../components/ui.tsx';

const SUGGESTED = [
  { title: 'Morning brief', text: 'Give me a brief of my day: calendar, important unread email, open tasks and the weather.' },
  { title: 'Inbox triage', text: 'Summarize my unread email across all accounts and flag anything that needs a reply today.' },
  { title: 'This week', text: 'What does my calendar look like this week? Point out conflicts and free blocks.' },
  { title: 'System check', text: 'Run a quick health check of this machine: CPU, memory, disk and anything unusual.' },
];

const QUICK = [
  'Brief me on today',
  'What needs my attention?',
  'Summarize unread Slack mentions',
  'Add a task: …',
  'Remember that …',
  'Search the web for …',
];

function useStoredKind(): [SessionKind, (k: SessionKind) => void] {
  const [k, setK] = useState<SessionKind>(() => {
    try {
      return (localStorage.getItem('monarch.comms.kind') as SessionKind) === 'automation' ? 'automation' : 'chat';
    } catch {
      return 'chat';
    }
  });
  return [
    k,
    (v) => {
      setK(v);
      try {
        localStorage.setItem('monarch.comms.kind', v);
      } catch {
        /* ignore */
      }
    },
  ];
}

export default function CommsPage(props: { params: string[] }) {
  const routeId = props.params[0];
  const isNew = routeId === 'new';
  const sessionId = routeId && !isNew ? routeId : null;

  const [kind, setKind] = useStoredKind();
  const [query, setQuery] = useState('');
  const [inject, setInject] = useState<{ text: string; n: number } | null>(null);
  const list = useSessions(kind);
  const chats = useSessions('chat');
  const chat = useChatSession(sessionId);
  const s = settings.value;

  // no id → open the most recent chat (or stay in "new" mode when there is none)
  useEffect(() => {
    if (routeId || !chats.sessions) return;
    if (chats.sessions.length) location.replace(`#/comms/${encodeURIComponent(chats.sessions[0].id)}`);
    else location.replace('#/comms/new');
  }, [routeId, chats.sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = list.sessions ?? [];
    return q ? all.filter((x) => x.title.toLowerCase().includes(q) || x.model.toLowerCase().includes(q)) : all;
  }, [list.sessions, query]);

  const send = async (text: string) => {
    try {
      const id = await chat.sendMessage(text, { kind: 'chat' });
      if (id !== sessionId) location.replace(`#/comms/${encodeURIComponent(id)}`);
    } catch (e: any) {
      if (e?.message !== 'Cancelled') toast(e?.message ?? String(e), 'error');
    }
  };

  const newChat = () => {
    navigate('comms/new');
    requestAnimationFrame(() => focusComposer());
  };

  const quick = (text: string) => {
    if (text.includes('…')) setInject({ text: text.replace(/\s*…$/, ' '), n: Date.now() });
    else void send(text);
  };

  const commands: SlashCommand[] = [
    { cmd: '/new', description: 'Start a new conversation', run: newChat },
    { cmd: '/stop', description: 'Stop the running response', run: () => chat.abort() },
    {
      cmd: '/rename',
      description: 'Rename this conversation — /rename <title>',
      run: (arg) => {
        if (!chat.session?.id) return toast('Nothing to rename yet', 'warn');
        if (!arg.trim()) return toast('Usage: /rename <title>', 'info');
        void renameSession(chat.session.id, arg.trim()).catch((e) => toast(String(e?.message ?? e), 'error'));
      },
    },
  ];

  const session = chat.session;
  const title = session?.title || (isNew || !routeId ? 'New conversation' : 'Conversation');

  return (
    <div class="h-full p-3 grid gap-3 grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_260px]">
      {/* ── sessions ── */}
      <Panel
        code="COM.01"
        title="Sessions"
        noPad
        bodyClass="flex flex-col"
        right={
          <button class="btn btn-xs btn-ghost rounded-[2px] font-mono font-normal uppercase tracking-wider text-[10px] text-fg-2 hover:text-fg px-1.5" onClick={newChat} title="New chat">
            <Plus size={12} /> New
          </button>
        }
      >
        <div class="p-2.5 flex flex-col gap-2 border-b border-line">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'chat', label: 'Chats' },
              { value: 'automation', label: 'Automations' },
            ]}
          />
          <label class="flex items-center gap-2 border border-line bg-[#121213] px-2 h-7 focus-within:border-fg-3">
            <Search size={12} class="text-fg-3" />
            <input
              class="flex-1 min-w-0 bg-transparent outline-none text-[12px] placeholder:text-fg-3"
              placeholder="Search sessions"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            />
          </label>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto py-1">
          {list.loading && !list.sessions ? (
            <div class="flex justify-center py-6">
              <Spinner />
            </div>
          ) : list.error && !list.sessions ? (
            <div class="px-3">
              <ErrorLine error={conn.value === 'open' ? list.error : 'Core offline'} />
            </div>
          ) : filtered.length === 0 ? (
            <Empty>{query ? 'No matches' : kind === 'chat' ? 'No conversations yet' : 'No automation runs yet'}</Empty>
          ) : (
            filtered.map((x) => (
              <SessionRow
                key={x.id}
                s={x}
                active={x.id === chat.sessionId}
                href={`#/comms/${encodeURIComponent(x.id)}`}
                onDeleted={(id) => id === chat.sessionId && location.replace('#/comms/new')}
              />
            ))
          )}
        </div>
      </Panel>

      {/* ── transcript ── */}
      <Panel
        code="COM.02"
        title={title}
        active={chat.running}
        noPad
        bodyClass="flex flex-col"
        right={
          <>
            {session && session.kind !== 'chat' && <Tag>{session.kind}</Tag>}
            {chat.running ? <Tag tone="red">live</Tag> : session?.id ? <Tag>idle</Tag> : null}
          </>
        }
      >
        {chat.loading && !session ? (
          <div class="flex-1 flex items-center justify-center">
            <Spinner />
          </div>
        ) : chat.error && !session ? (
          <div class="flex-1 flex flex-col items-center justify-center gap-3">
            <ErrorLine error={chat.error} />
            <div class="flex gap-2">
              {chat.error !== 'Session not found' && chat.error !== 'Session deleted' && (
                <button class="btn btn-xs btn-outline border-line rounded-[2px] font-mono font-normal uppercase text-[10px] text-fg-2" onClick={() => void chat.reload()}>
                  Retry
                </button>
              )}
              <button class="btn btn-xs btn-primary rounded-[2px] font-mono font-normal uppercase text-[10px]" onClick={newChat}>
                New chat
              </button>
            </div>
          </div>
        ) : (
          <Transcript
            items={session?.items ?? []}
            sessionId={chat.sessionId}
            running={chat.running}
            empty={<EmptyState name={s?.user.name} honorific={s?.user.honorific} assistant={s?.assistant.name} onPick={(t) => void send(t)} />}
          />
        )}
        <Composer
          onSend={send}
          onAbort={chat.abort}
          running={chat.running}
          commands={commands}
          inject={inject}
          autoFocus
          disabled={!!chat.error && !session}
          placeholder={session?.id ? 'Reply…' : `Message ${s?.assistant.name || 'Monarch'}…`}
          meta={
            <>
              <span class="inline-block w-1.5 h-1.5 bg-fg-3" />
              <span class="truncate">{engineLabel(s, session?.id ? session.engine : undefined, session?.id ? session.model : undefined)}</span>
              {session && totalTokens(session.usage) > 0 && <span class="hidden lg:inline">{fmt.num(totalTokens(session.usage))} tok</span>}
            </>
          }
        />
      </Panel>

      {/* ── context ── */}
      <Panel code="COM.03" title="Context" class="hidden xl:flex" bodyClass="overflow-y-auto flex flex-col gap-5">
        {session?.id ? (
          <SessionStats session={session} lastTurn={chat.lastTurn} />
        ) : (
          <div class="text-[12px] text-fg-3 leading-relaxed">
            New conversation on <span class="font-mono text-fg-2">{engineLabel(s)}</span>. Change the default engine in{' '}
            <a href="#/config/models" class="text-fg-2 underline decoration-red underline-offset-2">
              Config → Models
            </a>
            .
          </div>
        )}
        <div>
          <div class="hud-label mb-2">Quick prompts</div>
          <div class="flex flex-col">
            {QUICK.map((q) => (
              <button
                key={q}
                class="text-left text-[12.5px] text-fg-2 hover:text-fg hover:bg-white/[0.02] px-2 py-1.5 border-l border-line hover:border-red disabled:opacity-40"
                onClick={() => quick(q)}
                disabled={chat.running || conn.value !== 'open'}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function EmptyState(props: { name?: string; honorific?: string; assistant?: string; onPick: (t: string) => void }) {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'evening' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const who = props.honorific || props.name || '';
  return (
    <div class="h-full flex flex-col items-center justify-center px-6 py-10">
      <div class="w-10 h-10 border border-line flex items-center justify-center mb-5 relative">
        <span class="w-2 h-2 bg-red" />
        <span class="absolute -top-px -left-px w-2 h-2 border-t border-l border-fg-3" />
        <span class="absolute -bottom-px -right-px w-2 h-2 border-b border-r border-fg-3" />
      </div>
      <h2 class="text-xl text-fg font-light tracking-tight">
        Good {part}
        {who ? <>, {who}</> : null}.
      </h2>
      <p class="text-[13px] text-fg-3 mt-1.5">{props.assistant || 'Monarch'} is standing by. Ask anything, or start with one of these.</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-6 w-full max-w-[640px]">
        {SUGGESTED.map((p, i) => (
          <button
            key={p.title}
            class="text-left border border-line bg-[#18181a] hover:border-fg-3 hover:bg-subtle/40 px-3 py-2.5 group disabled:opacity-50"
            onClick={() => props.onPick(p.text)}
            disabled={conn.value !== 'open'}
          >
            <div class="flex items-center gap-2 font-mono text-[10px] tracking-[0.14em] uppercase text-fg-3 group-hover:text-fg-2">
              {i % 2 ? <Zap size={11} strokeWidth={1.5} /> : <MessageSquare size={11} strokeWidth={1.5} />}
              <span>P.{String(i + 1).padStart(2, '0')}</span>
              <span class="text-fg-2">{p.title}</span>
            </div>
            <div class="text-[12.5px] text-fg-2 mt-1 leading-snug">{p.text}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
