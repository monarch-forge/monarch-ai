/**
 * Memory — Obsidian-like vault: force-directed graph (main) + note drawer (right).
 * Route: #/memory/:noteId?   (note id is a vault-relative path, URL-encoded as one segment)
 * Dev affordance: open with `?demo=1` (before the hash) to render a generated graph without a core.
 */
import { useMemo, useRef, useState } from 'preact/hooks';
import type { MemoryGraph, MemoryNote } from '@monarch/shared';
import { Search, Network } from 'lucide-preact';
import { Panel, Tag } from '../components/ui.tsx';
import { useResource } from '../lib/store.ts';
import { GraphCanvas, type GraphCanvasHandle } from '../components/graph/graph-view.tsx';
import { filterGraph, normalizeGraph } from '../components/graph/model.ts';
import { demoGraph, demoNoteBody, demoRequested } from '../components/graph/demo.ts';
import { NewNoteModal, NoteList, NoteView, openNote } from '../components/memory/note-panel.tsx';
import { LoadError, Loading, StateBlock, useHotkeys } from '../components/mail/kit.tsx';

const DEMO_N = demoRequested();

export default function MemoryPage(props: { params: string[] }) {
  const noteId = props.params.length ? props.params.join('/') : null;
  const demo = DEMO_N !== null;

  const res = useResource<MemoryGraph>(demo ? null : '/memory/graph', ['memory']);
  const demoData = useMemo(() => (demo ? demoGraph(DEMO_N ?? 140) : null), []);
  const graph = useMemo(() => (demo ? demoData! : normalizeGraph(res.data)), [res.data, demoData]);

  const [showTags, setShowTags] = useState(false);
  const [showGhosts, setShowGhosts] = useState(true);
  const [local, setLocal] = useState(false);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const handle = useRef<GraphCanvasHandle | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const view = useMemo(
    () => filterGraph(graph, { showTags, showGhosts, localId: local ? noteId : null, depth: 2 }),
    [graph, showTags, showGhosts, local, local ? noteId : null],
  );
  const localUnavailable = local && (!noteId || !view.local);

  const demoNote: MemoryNote | null = useMemo(() => {
    if (!demo || !noteId) return null;
    const n = graph.nodes.find((x) => x.id === noteId);
    if (!n) return null;
    const now = new Date().toISOString();
    return {
      id: n.id,
      title: n.title,
      body: demoNoteBody(n.id, graph),
      tags: n.tags,
      links: graph.edges.filter((e) => e.source === n.id && e.kind === 'link').map((e) => e.target),
      backlinks: graph.edges.filter((e) => e.target === n.id && e.kind === 'link').map((e) => e.source),
      createdAt: now,
      updatedAt: now,
      source: 'agent',
    };
  }, [demo, noteId, graph]);

  useHotkeys({
    '/': () => searchRef.current?.focus(),
    n: () => setNewOpen(true),
    l: () => noteId && setLocal((v) => !v),
    t: () => setShowTags((v) => !v),
    g: () => setShowGhosts((v) => !v),
  });

  const onTag = (tag: string) => {
    setSearch(`#${tag}`);
    if (!showTags) setShowTags(true);
  };

  const hasData = demo || res.data !== undefined;
  const noteCount = graph.nodes.filter((n) => n.kind === 'note').length;

  return (
    <div class="h-full p-3 flex gap-3 min-h-0">
      <Panel
        code="MEM.01"
        title="Knowledge graph"
        class="flex-1 min-w-0"
        noPad
        bodyClass="flex flex-col"
        right={
          <>
            {demo && <Tag tone="warn">demo</Tag>}
            {res.loading && hasData && !demo && <span class="loading loading-spinner loading-xs text-fg-3" />}
            <Tag>{noteCount} notes</Tag>
          </>
        }
      >
        {/* toolbar */}
        <div class="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap">
          <label class="relative w-60">
            <Search size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
            <input
              ref={searchRef}
              class="hud-input py-1.5! pl-7! text-[13px]!"
              placeholder="Highlight nodes… (#tag)"
              value={search}
              aria-label="Highlight nodes in graph"
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matches.length) {
                  e.preventDefault();
                  if (e.shiftKey || e.ctrlKey) openNote(matches[0]);
                  else handle.current?.focus(matches[0]);
                } else if (e.key === 'Escape') {
                  setSearch('');
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </label>
          {search.trim() && <span class="font-mono text-[10px] tracking-widest uppercase text-fg-3">{matches.length} match{matches.length === 1 ? '' : 'es'}</span>}
          <div class="ml-auto flex items-center gap-1.5">
            <Toggle on={local} onClick={() => setLocal(!local)} title="Only the open note and neighbours within 2 hops (l)" disabled={!noteId && !local}>
              Local
            </Toggle>
            <Toggle on={showTags} onClick={() => setShowTags(!showTags)} title="Show tag nodes (t)">
              Tags
            </Toggle>
            <Toggle on={showGhosts} onClick={() => setShowGhosts(!showGhosts)} title="Show unresolved links (g)">
              Ghosts
            </Toggle>
          </div>
        </div>
        <div class="flex-1 min-h-0 relative">
          {!hasData && res.error ? (
            <div class="absolute inset-0 flex items-center justify-center">
              <LoadError error={res.error} onRetry={res.reload} />
            </div>
          ) : !hasData ? (
            <div class="absolute inset-0 flex items-center justify-center">
              <Loading label="Mapping vault" />
            </div>
          ) : !graph.nodes.length ? (
            <div class="absolute inset-0 flex items-center justify-center">
              <StateBlock icon={<Network size={28} strokeWidth={1} />} title="No notes yet">
                Notes you or Monarch write into the vault appear here as a living graph. Link notes with [[wikilinks]] to connect them.
              </StateBlock>
            </div>
          ) : (
            <>
              <GraphCanvas
                view={view}
                selectedId={noteId}
                search={search}
                fitKey={view.local ? `L:${noteId}` : 'G'}
                onOpen={(n) => {
                  if (n.kind === 'tag') onTag(n.id.replace(/^#/, ''));
                  else openNote(n.id);
                }}
                onSearchMatches={setMatches}
                handle={(h) => (handle.current = h)}
              />
              {localUnavailable && (
                <div class="absolute top-3 left-3 font-mono text-[10px] tracking-widest uppercase text-fg-3 bg-surface/90 border border-line px-2 py-1">
                  {noteId ? 'Open note not in graph — showing full vault' : 'Open a note to see its local graph'}
                </div>
              )}
              {view.local && (
                <div class="absolute top-3 left-3 font-mono text-[10px] tracking-widest uppercase text-fg-2 bg-surface/90 border border-line px-2 py-1">
                  Local · depth 2
                </div>
              )}
            </>
          )}
        </div>
      </Panel>

      <Panel code="MEM.02" title={noteId ? 'Note' : 'Vault'} class="w-[400px] xl:w-[440px] shrink-0" noPad bodyClass="flex flex-col">
        {noteId ? (
          <NoteView id={noteId} nodes={graph.nodes} demo={demo ? demoNote : undefined} onTag={onTag} onLocate={(id) => handle.current?.focus(id)} />
        ) : (
          <NoteList demoNodes={demo ? graph.nodes : null} onNew={() => setNewOpen(true)} />
        )}
      </Panel>
      <NewNoteModal open={newOpen} onClose={() => setNewOpen(false)} nodes={graph.nodes} demo={demo} />
    </div>
  );
}

function Toggle(props: { on: boolean; onClick: () => void; title?: string; disabled?: boolean; children: string }) {
  return (
    <button
      class={`font-mono text-[10px] tracking-[0.12em] uppercase px-2 py-1 border inline-flex items-center gap-1.5 disabled:opacity-40 ${
        props.on ? 'border-fg-3 text-fg bg-subtle' : 'border-line text-fg-3 hover:text-fg-2'
      }`}
      aria-pressed={props.on}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span class={`inline-block w-1.5 h-1.5 ${props.on ? 'bg-red' : 'border border-fg-3'}`} />
      {props.children}
    </button>
  );
}
