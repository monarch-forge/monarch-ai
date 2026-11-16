/**
 * Workshop — coding sessions per workspace (route #/workshop/:id?, "new" or no id = new session). UI-B.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { EngineId } from '@monarch/shared';
import { Plus, FolderOpen, X, GitBranch, ChevronDown, RefreshCw, FolderGit2, SquarePen } from 'lucide-preact';
import { Spinner, ErrorLine, Btn, fmt } from '../components/ui.tsx';
import { ChatLayout, SideLabel, LiveBadge, Suggestions, ICON_BTN, useStoredFlag } from '../components/chat/layout.tsx';
import { Transcript } from '../components/chat/transcript.tsx';
import { Composer, focusComposer, type SlashCommand } from '../components/chat/composer.tsx';
import { SessionRow } from '../components/chat/session-list.tsx';
import { SessionStats, ContextMeter, compactCommand } from '../components/chat/meta.tsx';
import { ModelPicker, type ModelChoice } from '../components/chat/model-picker.tsx';
import { DirBrowser } from '../components/config/dir-browser.tsx';
import { saveSettings } from '../components/config/fields.tsx';
import { useChatSession, useSessions } from '../lib/chat-store.ts';
import { conn, navigate, settings, toast, useResource } from '../lib/store.ts';

interface GitInfo {
  branch: string | null;
  dirty: number;
  ahead: number;
  behind: number;
  recent: { hash: string; subject: string; date: string }[];
}
type GitResult = GitInfo | { error: string };

const WS_KEY = 'monarch.workshop.ws';

function norm(p: string | undefined): string {
  return (p ?? '').replace(/[\\/]+$/, '');
}
function base(p: string): string {
  const n = norm(p);
  return n.split(/[\\/]/).pop() || n || '/';
}
function readLS(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function writeLS(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

export default function WorkshopPage(props: { params: string[] }) {
  const routeId = props.params[0];
  const sessionId = routeId && routeId !== 'new' ? routeId : null;
  const s = settings.value;
  const workspaces = s?.coding.workspaces ?? [];

  const chat = useChatSession(sessionId);
  const coding = useSessions('coding');
  const session = chat.session;

  const [selected, setSelected] = useState<string>(() => readLS(WS_KEY) ?? '');
  const [browse, setBrowse] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useStoredFlag('monarch.workshop.details', false);
  // model chosen in the composer (null = default for new sessions / keep current for an open one)
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  useEffect(() => setChoice(null), [sessionId]);
  const effEngine: EngineId = choice?.engine ?? s?.engine ?? 'claude-sdk';

  // the open session decides the workspace; otherwise remembered → default → first
  useEffect(() => {
    if (session?.cwd && norm(session.cwd) !== norm(selected)) setSelected(session.cwd);
  }, [session?.cwd]);
  useEffect(() => {
    if (selected || !s) return;
    const fallback = s.coding.defaultWorkspace || s.coding.workspaces[0];
    if (fallback) setSelected(fallback);
  }, [s, selected]);
  useEffect(() => {
    if (selected) writeLS(WS_KEY, selected);
  }, [selected]);

  const cwd = session?.id ? session.cwd || selected : selected;

  const allWs = useMemo(() => {
    const list = workspaces.map(norm);
    if (selected && !list.includes(norm(selected))) list.push(norm(selected));
    return list;
  }, [workspaces.join('|'), selected]);

  const byWs = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of coding.sessions ?? []) m.set(norm(x.cwd), (m.get(norm(x.cwd)) ?? 0) + 1);
    return m;
  }, [coding.sessions]);

  const wsSessions = useMemo(() => (coding.sessions ?? []).filter((x) => norm(x.cwd) === norm(selected)), [coding.sessions, selected]);
  const otherCount = useMemo(() => (coding.sessions ?? []).filter((x) => !allWs.includes(norm(x.cwd))).length, [coding.sessions, allWs]);

  const addWorkspace = async (path: string) => {
    setBrowse(false);
    const p = norm(path);
    setSelected(p);
    if (workspaces.map(norm).includes(p)) return;
    await saveSettings({ coding: { workspaces: [...workspaces, p] } } as any, `Workspace added: ${base(p)}`);
  };

  const removeWorkspace = async (path: string) => {
    const next = workspaces.filter((w) => norm(w) !== norm(path));
    await saveSettings({ coding: { workspaces: next } } as any, `Workspace removed: ${base(path)}`);
    if (norm(selected) === norm(path)) setSelected(next[0] ?? '');
  };

  const pickWorkspace = (p: string) => {
    setSelected(p);
    if (sessionId) navigate('workshop/new');
  };

  const send = async (text: string) => {
    if (!session?.id && !cwd) {
      toast('Choose a workspace first', 'warn');
      return;
    }
    try {
      const id = await chat.sendMessage(text, { kind: 'coding', cwd, engine: session?.id ? choice?.engine : effEngine, model: choice?.model });
      if (id !== sessionId) location.replace(`#/workshop/${encodeURIComponent(id)}`);
    } catch (e: any) {
      if (e?.message !== 'Cancelled') toast(e?.message ?? String(e), 'error');
    }
  };

  const newSession = () => {
    navigate('workshop/new');
    requestAnimationFrame(() => focusComposer());
  };

  const commands: SlashCommand[] = [
    { cmd: '/new', description: 'New coding session in this workspace', run: newSession },
    { cmd: '/stop', description: 'Stop the running agent', run: () => chat.abort() },
    { cmd: '/compact', description: 'Summarize older turns to free up context', run: () => compactCommand(chat.session?.id, chat.running) },
  ];

  const isNewMode = !session?.id;

  const sidebar = (
    <>
      <div class="px-3 pt-3 relative">
        <button
          class="w-full flex items-center gap-2.5 rounded-[8px] px-3 h-11 bg-[var(--bg-primary)]/60 hover:bg-[var(--bg-raised,#202023)] text-left transition-colors duration-150"
          onClick={() => setWsOpen(!wsOpen)}
          aria-expanded={wsOpen}
          title={selected || 'Choose a workspace'}
        >
          <FolderGit2 size={16} strokeWidth={1.75} class="text-fg-3 shrink-0" />
          <span class="flex-1 min-w-0">
            <span class="block text-[11px] text-fg-3 leading-tight">Workspace</span>
            <span class="block truncate text-[13.5px] text-fg leading-tight">{selected ? base(selected) : 'Choose one…'}</span>
          </span>
          <ChevronDown size={15} strokeWidth={1.75} class={`text-fg-3 shrink-0 transition-transform duration-150 ${wsOpen ? 'rotate-180' : ''}`} />
        </button>
        {wsOpen && (
          <div class="mt-1.5 rounded-[10px] bg-[var(--bg-primary)]/60 p-1">
            {!s ? (
              <div class="flex justify-center py-3">{conn.value === 'open' ? <Spinner /> : <ErrorLine error="Core offline" />}</div>
            ) : (
              allWs.map((w) => {
                const saved = workspaces.map(norm).includes(w);
                const on = norm(selected) === w;
                return (
                  <div
                    key={w}
                    class={`group flex items-center gap-2 rounded-[6px] px-2.5 py-2 cursor-pointer transition-colors duration-150 ${on ? 'bg-[var(--bg-raised,#202023)]' : 'hover:bg-[var(--bg-raised,#202023)]'}`}
                    onClick={() => {
                      pickWorkspace(w);
                      setWsOpen(false);
                    }}
                    title={w}
                  >
                    <span class={`flex-1 min-w-0 truncate text-[13px] ${on ? 'text-fg' : 'text-fg-2'}`}>
                      {base(w)}
                      {norm(s.coding.defaultWorkspace) === w && <span class="text-[11px] text-fg-3 ml-1.5">default</span>}
                    </span>
                    <span class="text-[11px] text-fg-3 tabular-nums group-hover:hidden">{byWs.get(w) ?? 0}</span>
                    {saved ? (
                      <button
                        class="text-fg-3 hover:text-red hidden group-hover:block"
                        title="Remove from list (files are untouched)"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeWorkspace(w);
                        }}
                      >
                        <X size={13} />
                      </button>
                    ) : (
                      <button
                        class="text-[11.5px] text-fg-3 hover:text-fg hidden group-hover:block"
                        title="Save to workspace list"
                        onClick={(e) => {
                          e.stopPropagation();
                          void addWorkspace(w);
                        }}
                      >
                        Save
                      </button>
                    )}
                  </div>
                );
              })
            )}
            <button
              class="w-full flex items-center gap-2 rounded-[6px] px-2.5 py-2 text-[13px] text-fg-3 hover:text-fg hover:bg-[var(--bg-raised,#202023)] disabled:opacity-40"
              onClick={() => {
                setWsOpen(false);
                setBrowse(true);
              }}
              disabled={conn.value !== 'open'}
            >
              <Plus size={14} strokeWidth={1.75} /> Add a folder…
            </button>
          </div>
        )}
      </div>
      <SideLabel
        right={
          <button class={`${ICON_BTN} w-7 h-7 -my-1`} onClick={newSession} disabled={!selected} title="New session" aria-label="New session">
            <SquarePen size={15} strokeWidth={1.75} />
          </button>
        }
      >
        Sessions
      </SideLabel>
      <div class="flex-1 min-h-0 overflow-y-auto pb-2">
        {coding.loading && !coding.sessions ? (
          <div class="flex justify-center py-6">
            <Spinner />
          </div>
        ) : coding.error && !coding.sessions ? (
          <div class="px-4">
            <ErrorLine error={conn.value === 'open' ? coding.error : 'Core offline'} />
          </div>
        ) : !selected ? (
          <p class="px-5 py-4 text-[13px] text-fg-3">Pick a workspace to see its sessions.</p>
        ) : wsSessions.length === 0 ? (
          <p class="px-5 py-4 text-[13px] text-fg-3 leading-relaxed">No sessions here yet. Describe a task to start one.</p>
        ) : (
          wsSessions.map((x) => (
            <SessionRow
              key={x.id}
              s={x}
              active={x.id === chat.sessionId}
              href={`#/workshop/${encodeURIComponent(x.id)}`}
              onDeleted={(id) => id === chat.sessionId && location.replace('#/workshop/new')}
            />
          ))
        )}
        {otherCount > 0 && <p class="px-5 pt-3 text-[11.5px] text-fg-3">{otherCount === 1 ? '1 session lives' : `${otherCount} sessions live`} in folders not on your list.</p>}
      </div>
    </>
  );

  const details = (
    <>
      {session?.id ? <SessionStats session={session} lastTurn={chat.lastTurn} /> : null}
      <EngineNote engine={session?.id ? session.engine : effEngine} />
      {cwd && <GitLog cwd={cwd} refreshKey={chat.running ? 1 : 0} />}
    </>
  );

  return (
    <>
      <ChatLayout
        sidebar={sidebar}
        routeKey={routeId}
        detailsOpen={detailsOpen}
        onDetails={setDetailsOpen}
        details={details}
        title={
          <>
            <h1 class="truncate text-[15px] font-semibold text-fg">{session?.title || 'New coding session'}</h1>
            <LiveBadge running={chat.running} />
          </>
        }
        actions={<GitChip cwd={cwd} refreshKey={chat.running ? 1 : 0} />}
      >
        {session?.parentSessionId && (
          <div class="max-w-[760px] w-full mx-auto px-4 md:px-6 pb-2 -mt-1 text-[12.5px] text-fg-3">
            Delegated from{' '}
            <a href={`#/comms/${encodeURIComponent(session.parentSessionId)}`} class="text-fg-2 underline decoration-fg-3 underline-offset-[3px] hover:text-fg">
              a chat
            </a>
          </div>
        )}
        {chat.loading && !session ? (
          <div class="flex-1 flex items-center justify-center">
            <Spinner />
          </div>
        ) : chat.error && !session ? (
          <div class="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <p class="text-[14px] text-fg-2">Couldn’t open this session.</p>
            <ErrorLine error={chat.error} />
            <Btn variant="primary" onClick={newSession}>
              New session
            </Btn>
          </div>
        ) : (
          <Transcript
            items={session?.items ?? []}
            sessionId={chat.sessionId}
            running={chat.running}
            expandEdits
            empty={<WorkshopEmpty cwd={cwd} engine={effEngine} onBrowse={() => setBrowse(true)} onPick={(t) => void send(t)} />}
          />
        )}
        <Composer
          onSend={send}
          onAbort={chat.abort}
          running={chat.running}
          commands={commands}
          autoFocus
          disabled={(isNewMode && !cwd) || (!!chat.error && !session)}
          placeholder={isNewMode ? (cwd ? `What should we work on in ${base(cwd)}?` : 'Add or pick a workspace first') : 'Follow up…'}
          meta={session?.id ? <ContextMeter context={session.context} autoCompactPercent={s?.agent?.autoCompactPercent} /> : null}
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
      <DirBrowser open={browse} initialPath={selected || s?.coding.defaultWorkspace || ''} title="Add workspace" confirmLabel="Use this folder" onPick={(p) => void addWorkspace(p)} onClose={() => setBrowse(false)} />
    </>
  );
}

function EngineNote(props: { engine: EngineId }) {
  return props.engine === 'claude-sdk' ? (
    <div class="text-[12.5px] text-fg-2 leading-relaxed">
      <div class="text-[12px] text-fg-3 mb-1">Engine · Claude Code</div>
      Runs the Claude Agent SDK with Claude Code's own tools (Bash, Read, Edit, Write, Grep…) on your Claude subscription. Risky tools are gated by your
      permission mode.
    </div>
  ) : (
    <div class="text-[12.5px] text-fg-2 leading-relaxed">
      <div class="text-[12px] text-fg-3 mb-1">Engine · Pi</div>
      Runs the pi agent loop on the provider configured in{' '}
      <a href="#/config/models" class="text-fg underline decoration-fg-3 underline-offset-[3px]">
        Config → Models
      </a>{' '}
      with Monarch's coding tools (shell, read, edit, write).
    </div>
  );
}

function WorkshopEmpty(props: { cwd: string; engine: EngineId; onBrowse: () => void; onPick: (t: string) => void }) {
  const prompts = ['Give me a tour of this codebase', 'Find and fix failing tests', 'Review my uncommitted changes', 'Add setup steps to the README'];
  if (!props.cwd)
    return (
      <div class="min-h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <FolderOpen size={26} strokeWidth={1.25} class="text-fg-3" />
        <h2 class="text-[18px] font-semibold text-fg">Pick a project to work on</h2>
        <p class="text-[13.5px] text-fg-3 max-w-[340px]">Add a folder and Monarch can read, edit and run code in it with you.</p>
        <Btn variant="primary" class="mt-2" onClick={props.onBrowse}>
          Add a workspace
        </Btn>
      </div>
    );
  return (
    <div class="min-h-full flex flex-col items-center justify-center px-6 py-10 text-center">
      <FolderGit2 size={26} strokeWidth={1.25} class="text-fg-3 mb-4" />
      <h2 class="text-[20px] font-semibold text-fg tracking-tight">What are we building in {base(props.cwd)}?</h2>
      <p class="text-[12px] text-fg-3 mt-2 font-mono break-all max-w-[520px]">{props.cwd}</p>
      <p class="text-[12.5px] text-fg-3 mt-1">with {props.engine === 'pi' ? 'Pi' : 'Claude Code'}</p>
      <div class="mt-7">
        <Suggestions items={prompts} onPick={props.onPick} disabled={conn.value !== 'open'} />
      </div>
    </div>
  );
}

function useGit(cwd: string, refreshKey: number) {
  const git = useResource<GitResult>(cwd ? `/coding/git?cwd=${encodeURIComponent(cwd)}` : null, []);
  const prev = useRef(refreshKey);
  // refresh after an agent turn finishes
  useEffect(() => {
    if (prev.current && !refreshKey) void git.reload();
    prev.current = refreshKey;
  }, [refreshKey]);
  const d = git.data;
  const info = d && !('error' in d) ? d : null;
  const err = d && 'error' in d ? d.error : git.error;
  return { git, info, err };
}

/** compact branch + changes chip for the header; click to refresh */
function GitChip(props: { cwd: string; refreshKey: number }) {
  const { git, info, err } = useGit(props.cwd, props.refreshKey);
  if (!props.cwd) return null;
  const tip = info
    ? `${props.cwd}\nBranch ${info.branch ?? 'detached'} · ${info.dirty ? `${info.dirty} uncommitted change${info.dirty === 1 ? '' : 's'}` : 'clean'}${
        info.ahead || info.behind ? ` · ↑${info.ahead} ↓${info.behind}` : ''
      }\nClick to refresh`
    : (err ?? props.cwd);
  return (
    <button
      class="hidden sm:inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-[var(--bg-surface)] hover:bg-[var(--bg-raised,#202023)] text-[12px] text-fg-2 shrink-0 max-w-[240px] transition-colors duration-150"
      title={tip}
      onClick={() => void git.reload()}
    >
      {git.loading && !git.data ? (
        <Spinner />
      ) : info ? (
        <>
          <GitBranch size={13} strokeWidth={1.75} class="text-fg-3 shrink-0" />
          <span class="truncate">{info.branch ?? 'detached'}</span>
          {info.dirty > 0 && <span class="text-warning tabular-nums">±{info.dirty}</span>}
          {(info.ahead > 0 || info.behind > 0) && (
            <span class="text-fg-3 tabular-nums">
              ↑{info.ahead} ↓{info.behind}
            </span>
          )}
        </>
      ) : (
        <span class="text-fg-3">{err && /not a git|no git/i.test(err) ? 'Not a git repo' : err ? 'Git unavailable' : base(props.cwd)}</span>
      )}
    </button>
  );
}

/** recent commits, shown in the details column */
function GitLog(props: { cwd: string; refreshKey: number }) {
  const { git, info } = useGit(props.cwd, props.refreshKey);
  if (!info) return null;
  return (
    <div>
      <div class="flex items-center gap-2 mb-1.5">
        <span class="text-[12px] text-fg-3">
          <GitBranch size={12} strokeWidth={1.75} class="inline -mt-0.5 mr-1" />
          {info.branch ?? 'detached'} · {info.dirty ? `${info.dirty} uncommitted` : 'clean'}
        </span>
        <button class="ml-auto text-fg-3 hover:text-fg-2" title="Refresh" onClick={() => void git.reload()}>
          <RefreshCw size={12} strokeWidth={1.75} />
        </button>
      </div>
      {info.recent?.length > 0 && (
        <div class="flex flex-col">
          {info.recent.slice(0, 8).map((c) => (
            <div key={c.hash} class="py-1" title={c.hash}>
              <div class="text-[12.5px] text-fg-2 truncate">{c.subject}</div>
              <div class="text-[11px] text-fg-3">
                <span class="font-mono">{c.hash.slice(0, 7)}</span>
                {c.date ? ` · ${fmt.ago(c.date)}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
