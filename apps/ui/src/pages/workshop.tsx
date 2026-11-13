/**
 * WORKSHOP — coding sessions per workspace (route #/workshop/:id?, "new" or no id = new session). UI-B.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { EngineId } from '@monarch/shared';
import { Plus, FolderOpen, X, GitBranch, ChevronRight, RefreshCw, FolderGit2 } from 'lucide-preact';
import { Panel, Tag, Empty, Spinner, ErrorLine, fmt } from '../components/ui.tsx';
import { Transcript } from '../components/chat/transcript.tsx';
import { Composer, focusComposer, type SlashCommand } from '../components/chat/composer.tsx';
import { SessionRow } from '../components/chat/session-list.tsx';
import { SessionStats, engineLabel } from '../components/chat/meta.tsx';
import { ModelPicker, type ModelChoice } from '../components/chat/model-picker.tsx';
import { DirBrowser } from '../components/config/dir-browser.tsx';
import { saveSettings } from '../components/config/fields.tsx';
import { useChatSession, useSessions, totalTokens } from '../lib/chat-store.ts';
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
  ];

  const isNewMode = !session?.id;

  return (
    <div class="h-full p-3 grid gap-3 grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_260px]">
      {/* ── workspaces + sessions ── */}
      <div class="min-h-0 flex flex-col gap-3">
        <Panel
          code="WRK.01"
          title="Workspaces"
          noPad
          class="max-h-[45%]"
          bodyClass="overflow-y-auto py-1"
          right={
            <button class="btn btn-xs btn-ghost rounded-[2px] font-mono font-normal uppercase tracking-wider text-[10px] text-fg-2 hover:text-fg px-1.5" onClick={() => setBrowse(true)} disabled={conn.value !== 'open'}>
              <Plus size={12} /> Add
            </button>
          }
        >
          {!s ? (
            <div class="flex justify-center py-4">{conn.value === 'open' ? <Spinner /> : <ErrorLine error="Core offline" />}</div>
          ) : allWs.length === 0 ? (
            <div class="px-3 py-4 text-center">
              <div class="text-[12px] text-fg-3 mb-3">No workspaces yet. Add a project folder to start coding with Monarch.</div>
              <button class="btn btn-xs btn-primary rounded-[2px] font-mono font-normal uppercase text-[10px]" onClick={() => setBrowse(true)}>
                <FolderOpen size={12} /> Add workspace
              </button>
            </div>
          ) : (
            allWs.map((w) => {
              const saved = workspaces.map(norm).includes(w);
              return (
                <div key={w} class="hud-row group cursor-pointer" data-active={norm(selected) === w ? 'true' : 'false'} onClick={() => pickWorkspace(w)} title={w}>
                  <FolderGit2 size={13} strokeWidth={1.5} class={norm(selected) === w ? 'text-fg-2 shrink-0' : 'text-fg-3 shrink-0'} />
                  <div class="flex-1 min-w-0">
                    <div class={`truncate text-[13px] ${norm(selected) === w ? 'text-fg' : 'text-fg-2'}`}>
                      {base(w)}
                      {norm(s.coding.defaultWorkspace) === w && <span class="font-mono text-[9px] text-fg-3 ml-1.5 tracking-widest">DEFAULT</span>}
                    </div>
                    <div class="font-mono text-[10px] text-fg-3 truncate">{w}</div>
                  </div>
                  <span class="font-mono text-[10px] text-fg-3 tabular-nums">{byWs.get(w) ?? 0}</span>
                  {saved ? (
                    <button
                      class="text-fg-3 hover:text-red hidden group-hover:block"
                      title="Remove from list (files are untouched)"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeWorkspace(w);
                      }}
                    >
                      <X size={12} />
                    </button>
                  ) : (
                    <button
                      class="font-mono text-[9px] tracking-widest text-fg-3 hover:text-fg hidden group-hover:block"
                      title="Save to workspace list"
                      onClick={(e) => {
                        e.stopPropagation();
                        void addWorkspace(w);
                      }}
                    >
                      SAVE
                    </button>
                  )}
                </div>
              );
            })
          )}
        </Panel>

        <Panel
          code="WRK.02"
          title={selected ? `Sessions · ${base(selected)}` : 'Sessions'}
          noPad
          class="flex-1"
          bodyClass="overflow-y-auto py-1"
          right={
            <button class="btn btn-xs btn-ghost rounded-[2px] font-mono font-normal uppercase tracking-wider text-[10px] text-fg-2 hover:text-fg px-1.5" onClick={newSession} disabled={!selected}>
              <Plus size={12} /> New
            </button>
          }
        >
          {coding.loading && !coding.sessions ? (
            <div class="flex justify-center py-6">
              <Spinner />
            </div>
          ) : coding.error && !coding.sessions ? (
            <div class="px-3">
              <ErrorLine error={conn.value === 'open' ? coding.error : 'Core offline'} />
            </div>
          ) : !selected ? (
            <Empty>Select a workspace</Empty>
          ) : wsSessions.length === 0 ? (
            <Empty>No sessions in this workspace</Empty>
          ) : (
            wsSessions.map((x) => (
              <SessionRow
                key={x.id}
                s={x}
                active={x.id === chat.sessionId}
                href={`#/workshop/${encodeURIComponent(x.id)}`}
                onDeleted={(id) => id === chat.sessionId && location.replace('#/workshop/new')}
                sub={`${x.engine === 'claude-sdk' ? 'claude code' : 'pi'} · ${x.itemCount} items${totalTokens(x.usage) ? ` · ${fmt.num(totalTokens(x.usage))} tok` : ''}`}
              />
            ))
          )}
          {otherCount > 0 && <div class="px-3 pt-2 font-mono text-[10px] text-fg-3">{otherCount} session(s) in unlisted folders</div>}
        </Panel>
      </div>

      {/* ── main ── */}
      <Panel
        code="WRK.03"
        title={session?.title || 'New coding session'}
        active={chat.running}
        noPad
        bodyClass="flex flex-col"
        right={chat.running ? <Tag tone="red">live</Tag> : session?.id ? <Tag>idle</Tag> : <Tag tone="plain">draft</Tag>}
      >
        <GitBar cwd={cwd} refreshKey={chat.running ? 1 : 0} />
        {chat.loading && !session ? (
          <div class="flex-1 flex items-center justify-center">
            <Spinner />
          </div>
        ) : chat.error && !session ? (
          <div class="flex-1 flex flex-col items-center justify-center gap-3">
            <ErrorLine error={chat.error} />
            <button class="btn btn-xs btn-primary rounded-[2px] font-mono font-normal uppercase text-[10px]" onClick={newSession}>
              New session
            </button>
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
          placeholder={isNewMode ? (cwd ? `Describe a task in ${base(cwd)}…` : 'Add or select a workspace first') : 'Follow up…'}
          meta={
            <>
              <span class="inline-block w-1.5 h-1.5 bg-fg-3" />
              <span class="truncate">{session?.id ? engineLabel(s, session.engine, session.model) : engineLabel(s, effEngine, choice?.model)}</span>
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
      </Panel>

      {/* ── context ── */}
      <Panel code="WRK.04" title="Session" class="hidden xl:flex" bodyClass="overflow-y-auto flex flex-col gap-5">
        {session?.id ? (
          <SessionStats session={session} lastTurn={chat.lastTurn} />
        ) : (
          <div class="flex flex-col gap-3 text-[12px] text-fg-3 leading-relaxed">
            <EngineNote engine={effEngine} />
          </div>
        )}
      </Panel>

      <DirBrowser open={browse} initialPath={selected || s?.coding.defaultWorkspace || ''} title="Add workspace" confirmLabel="Use this folder" onPick={(p) => void addWorkspace(p)} onClose={() => setBrowse(false)} />
    </div>
  );
}

function EngineNote(props: { engine: EngineId }) {
  return props.engine === 'claude-sdk' ? (
    <div>
      <div class="hud-label mb-1.5">Claude Code</div>
      Runs the Claude Agent SDK with Claude Code's own tools (Bash, Read, Edit, Write, Grep…) on your Claude subscription. Risky tools are gated by your
      permission mode.
    </div>
  ) : (
    <div>
      <div class="hud-label mb-1.5">Pi</div>
      Runs the pi agent loop on the provider configured in{' '}
      <a href="#/config/models" class="text-fg-2 underline decoration-red underline-offset-2">
        Config → Models
      </a>{' '}
      with Monarch's coding tools (shell, read, edit, write).
    </div>
  );
}

function WorkshopEmpty(props: { cwd: string; engine: EngineId; onBrowse: () => void; onPick: (t: string) => void }) {
  const prompts = ['Give me a tour of this codebase', 'Find and fix the failing tests', 'Review uncommitted changes', 'Add a README section for setup'];
  if (!props.cwd)
    return (
      <div class="h-full flex flex-col items-center justify-center gap-3 px-6">
        <FolderOpen size={22} strokeWidth={1} class="text-fg-3" />
        <div class="text-[13px] text-fg-3">Pick a workspace folder to start a coding session.</div>
        <button class="btn btn-sm btn-primary rounded-[2px] font-mono font-normal uppercase text-[11px]" onClick={props.onBrowse}>
          Add workspace
        </button>
      </div>
    );
  return (
    <div class="h-full flex flex-col items-center justify-center px-6 py-10">
      <div class="font-mono text-[10px] tracking-[0.16em] uppercase text-fg-3">workspace</div>
      <div class="font-mono text-[15px] text-fg mt-1 break-all text-center">{props.cwd}</div>
      <div class="font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 mt-2">engine · {props.engine === 'pi' ? 'pi' : 'claude code'}</div>
      <div class="flex flex-col gap-1 mt-6 w-full max-w-[420px]">
        {prompts.map((p, i) => (
          <button
            key={p}
            class="text-left flex items-center gap-3 border border-line bg-[#18181a] hover:border-fg-3 px-3 py-2 text-[13px] text-fg-2 hover:text-fg disabled:opacity-50"
            onClick={() => props.onPick(p)}
            disabled={conn.value !== 'open'}
          >
            <span class="font-mono text-[10px] text-fg-3">T.{String(i + 1).padStart(2, '0')}</span>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function GitBar(props: { cwd: string; refreshKey: number }) {
  const git = useResource<GitResult>(props.cwd ? `/coding/git?cwd=${encodeURIComponent(props.cwd)}` : null, []);
  const [open, setOpen] = useState(false);
  const prev = useRef(props.refreshKey);
  // refresh after an agent turn finishes
  useEffect(() => {
    if (prev.current && !props.refreshKey) void git.reload();
    prev.current = props.refreshKey;
  }, [props.refreshKey]);

  if (!props.cwd) return null;
  const d = git.data;
  const info = d && !('error' in d) ? d : null;
  const err = d && 'error' in d ? d.error : git.error;

  return (
    <div class="border-b border-line bg-[#18181a]">
      <div class="flex items-center gap-3 px-4 h-8 font-mono text-[11px] min-w-0">
        <FolderOpen size={12} strokeWidth={1.5} class="text-fg-3 shrink-0" />
        <span class="text-fg-2 truncate min-w-0" title={props.cwd}>
          {props.cwd}
        </span>
        <span class="ml-auto flex items-center gap-3 shrink-0">
          {git.loading && !d ? (
            <Spinner />
          ) : info ? (
            <>
              <span class="flex items-center gap-1 text-fg">
                <GitBranch size={12} strokeWidth={1.5} class="text-fg-3" />
                {info.branch ?? 'detached'}
              </span>
              <span class={info.dirty ? 'text-warning' : 'text-fg-3'} title="Uncommitted changes">
                {info.dirty ? `±${info.dirty}` : 'clean'}
              </span>
              {(info.ahead > 0 || info.behind > 0) && (
                <span class="text-fg-2" title="Ahead / behind upstream">
                  ↑{info.ahead} ↓{info.behind}
                </span>
              )}
              {info.recent?.length > 0 && (
                <button class="flex items-center gap-1 text-fg-3 hover:text-fg-2 uppercase tracking-[0.12em] text-[10px]" onClick={() => setOpen(!open)} aria-expanded={open}>
                  <ChevronRight size={11} class={`transition-transform ${open ? 'rotate-90' : ''}`} /> log
                </button>
              )}
            </>
          ) : (
            <span class="text-fg-3" title={err}>
              {err && /not a git|no git/i.test(err) ? 'not a git repo' : err ? 'git unavailable' : ''}
            </span>
          )}
          <button class="text-fg-3 hover:text-fg-2" title="Refresh git status" onClick={() => void git.reload()}>
            <RefreshCw size={11} strokeWidth={1.5} />
          </button>
        </span>
      </div>
      {open && info && (
        <div class="px-4 pb-2 max-h-40 overflow-y-auto">
          {info.recent.map((c) => (
            <div key={c.hash} class="flex items-center gap-3 font-mono text-[11px] py-0.5">
              <span class="text-fg-3 w-16 shrink-0">{c.hash.slice(0, 7)}</span>
              <span class="text-fg-2 truncate flex-1">{c.subject}</span>
              <span class="text-fg-3 shrink-0">{c.date ? fmt.ago(c.date) : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
