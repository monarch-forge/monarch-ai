/**
 * Chat — conversations with Monarch (route #/chat/:id?, "#/chat/new" = blank session). UI-B.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { speak, stopSpeaking } from '../lib/voice.ts';
import { Search, SquarePen } from 'lucide-preact';
import { Tag, ErrorLine, Btn, Skeleton, Disclosure, EmptyState } from '../components/ui.tsx';
import { ChatLayout, LiveBadge, Suggestions, ICON_BTN } from '../components/chat/layout.tsx';
import { Transcript } from '../components/chat/transcript.tsx';
import { Composer, focusComposer, type SlashCommand } from '../components/chat/composer.tsx';
import { SessionRow } from '../components/chat/session-list.tsx';
import { SessionStats, engineLabel, ContextMeter, compactCommand } from '../components/chat/meta.tsx';
import { ModelPicker, type ModelChoice } from '../components/chat/model-picker.tsx';
import { ThreadsPanel } from '../components/chat/threads-panel.tsx';
import { useChatSession, useSessions, renameSession, totalTokens } from '../lib/chat-store.ts';
import { conn, navigate, settings, toast } from '../lib/store.ts';
import { fmt, DotText } from '../components/ui.tsx';

const SUGGESTED = [
  { title: 'Brief me on my day', text: 'Give me a brief of my day: calendar, important unread email, open tasks and the weather.' },
  { title: 'Triage my inbox', text: 'Summarize my unread email across all accounts and flag anything that needs a reply today.' },
  { title: 'How does my week look?', text: 'What does my calendar look like this week? Point out conflicts and free blocks.' },
  { title: 'Check this machine', text: 'Run a quick health check of this machine: CPU, memory, disk and anything unusual.' },
];

const QUICK = [
  'Brief me on today',
  'What needs my attention?',
  'Summarize unread Slack mentions',
  'Add a task: …',
  'Remember that …',
  'Search the web for …',
];

export default function CommsPage(props: { params: string[] }) {
  // "#/chat/automations/<id>?" = old deep link (core notifications); automations live in Agenda now
  const autoLink = props.params[0] === 'automations';
  const routeId = autoLink ? undefined : props.params[0];
  const isNew = routeId === 'new';
  const sessionId = routeId && !isNew ? routeId : null;

  const [query, setQuery] = useState('');
  useEffect(() => {
    if (autoLink) location.replace('#/agenda');
  }, [autoLink]);
  const [inject, setInject] = useState<{ text: string; n: number } | null>(null);
  const list = useSessions('chat');
  const chat = useChatSession(sessionId);
  const s = settings.value;
  // model chosen in the composer for this session (null = default for new / keep current for existing)
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  useEffect(() => setChoice(null), [sessionId]);

  // no id → open the most recent chat (or stay in "new" mode when there is none)
  useEffect(() => {
    if (routeId || autoLink || !list.sessions) return;
    if (list.sessions.length) location.replace(`#/chat/${encodeURIComponent(list.sessions[0].id)}`);
    else location.replace('#/chat/new');
  }, [routeId, list.sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = (list.sessions ?? []).filter((x) => !x.parentSessionId); // child sub-sessions live under their parent
    return q ? all.filter((x) => x.title.toLowerCase().includes(q) || x.model.toLowerCase().includes(q)) : all;
  }, [list.sessions, query]);

  // a turn asked by voice gets its reply spoken (when spoken replies are on)
  const voiceTurn = useRef(false);
  useEffect(() => {
    if (!chat.lastTurn || !voiceTurn.current) return;
    voiceTurn.current = false;
    if (chat.lastTurn.error) return;
    const items = chat.session?.items ?? [];
    const lastUser = items.map((i) => i.kind).lastIndexOf('user');
    const reply = items
      .slice(lastUser + 1)
      .filter((i) => i.kind === 'assistant')
      .map((i) => (i as { text: string }).text)
      .join('\n\n')
      .trim();
    if (reply) void speak(reply);
  }, [chat.lastTurn]);
  useEffect(() => () => stopSpeaking(), [sessionId]);

  const sendVoice = (text: string) => {
    voiceTurn.current = true;
    return send(text);
  };

  const send = async (text: string) => {
    try {
      const id = await chat.sendMessage(text, { kind: 'chat', engine: choice?.engine, model: choice?.model });
      if (id !== sessionId) location.replace(`#/chat/${encodeURIComponent(id)}`);
    } catch (e: any) {
      if (e?.message !== 'Cancelled') toast(e?.message ?? String(e), 'error');
    }
  };

  const newChat = () => {
    navigate('chat/new');
    requestAnimationFrame(() => focusComposer());
  };

  const quick = (text: string) => {
    if (text.includes('…')) setInject({ text: text.replace(/\s*…$/, ' '), n: Date.now() });
    else void send(text);
  };

  const commands: SlashCommand[] = [
    { cmd: '/new', description: 'Start a new conversation', run: newChat },
    { cmd: '/stop', description: 'Stop the running response', run: () => chat.abort() },
    { cmd: '/compact', description: 'Summarize older turns to free up context', run: () => compactCommand(chat.session?.id, chat.running) },
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

  const sidebar = (
    <>
      <div class="px-3 pt-3 flex items-center gap-1.5">
        <label class="flex-1 min-w-0 flex items-center gap-2 rounded-[8px] px-2.5 h-8 text-fg-3 hover:bg-[var(--bg-raised,#202023)] focus-within:bg-[var(--bg-raised,#202023)] transition-colors duration-150">
          <Search size={14} strokeWidth={1.75} />
          <input
            class="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-fg placeholder:text-fg-3"
            placeholder="Search"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
        </label>
        <button class={ICON_BTN} onClick={newChat} title="New chat" aria-label="New chat">
          <SquarePen size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div class="ds-label px-[22px] pt-5 pb-2">Sessions</div>
      <div class="flex-1 min-h-0 overflow-y-auto pb-2 flex flex-col gap-1">
        {list.loading && !list.sessions ? (
          <Skeleton lines={5} class="px-4 py-3" />
        ) : list.error && !list.sessions ? (
          <div class="px-4">
            <ErrorLine error={conn.value === 'open' ? list.error : 'Core offline'} />
          </div>
        ) : filtered.length === 0 ? (
          <p class="px-5 py-6 text-[13px] text-fg-3 leading-relaxed">
            {query
              ? 'Nothing matches that search.'
              : 'No conversations yet. Say hello to get started.'}
          </p>
        ) : (
          filtered.map((x) => (
            <SessionRow
              key={x.id}
              s={x}
              active={x.id === chat.sessionId}
              href={`#/chat/${encodeURIComponent(x.id)}`}
              onDeleted={(id) => id === chat.sessionId && location.replace('#/chat/new')}
            />
          ))
        )}
      </div>
    </>
  );

  const rail = (
    <>
      {session?.id ? (
        <>
          <ThreadsPanel sessionId={session.id} />
          <Disclosure label="Session" class="">
            <SessionStats session={session} lastTurn={chat.lastTurn} />
          </Disclosure>
        </>
      ) : (
        <p class="text-[13px] text-fg-3 leading-relaxed">
          New conversations use <span class="text-fg-2">{engineLabel(s)}</span>. You can change the default in{' '}
          <a href="#/config/models" class="text-fg-2 underline decoration-fg-3 underline-offset-[3px] hover:text-fg">
            Config → Models
          </a>
          .
        </p>
      )}
      <Disclosure label="Quick prompts" class="" bodyClass="flex flex-col -mx-2 pt-2">
          {QUICK.map((q) => (
            <button
              key={q}
              class="text-left text-[13px] text-fg-2 hover:text-fg hover:bg-[var(--bg-raised,#202023)] rounded-[var(--radius-control)] px-2 py-1.5 disabled:opacity-40 transition-colors duration-150"
              onClick={() => quick(q)}
              disabled={chat.running || conn.value !== 'open'}
            >
              {q}
            </button>
          ))}
      </Disclosure>
    </>
  );

  return (
    <ChatLayout
      sidebar={sidebar}
      routeKey={routeId}
      rail={rail}
      railTitle="Threads"
      title={
        <>
          <h1 class="truncate text-[15px] font-semibold text-fg">{title}</h1>
          {session && session.kind !== 'chat' && <Tag>{session.kind}</Tag>}
          <LiveBadge running={chat.running} />
        </>
      }
    >
      {chat.loading && !session ? (
        <div class="flex-1 px-4 md:px-6 pt-4 w-full max-w-[760px] mx-auto flex flex-col gap-8">
          <Skeleton h={40} class="self-end w-[45%] rounded-[16px]" />
          <Skeleton lines={4} />
          <Skeleton h={40} class="self-end w-[35%] rounded-[16px]" />
          <Skeleton lines={3} />
        </div>
      ) : chat.error && !session ? (
        <div class="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <p class="text-[14px] text-fg-2">{chat.error === 'Session not found' || chat.error === 'Session deleted' ? 'This conversation is no longer here.' : 'Couldn’t open this conversation.'}</p>
          <ErrorLine error={chat.error} />
          <div class="flex gap-2">
            {chat.error !== 'Session not found' && chat.error !== 'Session deleted' && (
              <Btn variant="ghost" onClick={() => void chat.reload()}>
                Try again
              </Btn>
            )}
            <Btn variant="primary" onClick={newChat}>
              New chat
            </Btn>
          </div>
        </div>
      ) : (
        <Transcript
          items={session?.items ?? []}
          sessionId={chat.sessionId}
          running={chat.running}
          empty={<ChatEmpty name={s?.user.name} honorific={s?.user.honorific} assistant={s?.assistant.name} onPick={(t) => void send(t)} />}
        />
      )}
      <Composer
        onSend={send}
        onVoiceSend={sendVoice}
        onAbort={chat.abort}
        running={chat.running}
        commands={commands}
        inject={inject}
        autoFocus
        disabled={!!chat.error && !session}
        placeholder={session?.id ? 'Reply…' : `Message ${s?.assistant.name || 'Monarch'}…`}
        meta={
          <>
            {session?.id && <ContextMeter context={session.context} autoCompactPercent={s?.agent?.autoCompactPercent} />}
            {session && totalTokens(session.usage) > 0 && <span class="hidden lg:inline tabular-nums">{fmt.num(totalTokens(session.usage))} tokens</span>}
          </>
        }
        tools={
          <ModelPicker
            value={choice}
            onChange={setChoice}
            lockEngine={session?.id ? session.engine : undefined}
            current={session?.id ? { engine: session.engine, model: session.model } : null}
            noDefault={!!session?.id}
          />
        }
      />
    </ChatLayout>
  );
}

function ChatEmpty(props: { name?: string; honorific?: string; assistant?: string; onPick: (t: string) => void }) {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'evening' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const who = props.honorific || props.name || '';
  return (
    <EmptyState
      class="min-h-full"
      title={
        <span class="flex flex-col items-center gap-2">
          <DotText class="text-[40px] leading-none tracking-[0.04em] uppercase">Good {part}</DotText>
          {who ? <span class="ds-label">{who}</span> : null}
        </span>
      }
      hint={`What can ${props.assistant || 'Monarch'} help you with?`}
      actions={
        <div class="mt-4">
          <Suggestions items={SUGGESTED.map((p) => p.title)} onPick={(t) => props.onPick(SUGGESTED.find((p) => p.title === t)!.text)} disabled={conn.value !== 'open'} />
        </div>
      }
    />
  );
}
