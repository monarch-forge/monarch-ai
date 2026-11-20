/**
 * Right-hand drawer of the Memory page: vault list/search, note reader (markdown with [[wikilinks]]),
 * backlinks, edit mode, new-note modal, delete.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { MemoryNote, MemoryNoteSummary } from '@monarch/shared';
import { ArrowLeft, Crosshair, FilePlus, Pencil, Search, Sparkles, Trash, Link2 } from 'lucide-preact';
import { api, ApiError, openExternal, qs } from '../../lib/api.ts';
import { navigate, toast, useResource } from '../../lib/store.ts';
import { Btn, EmptyState, Skeleton, Tag } from '../ui.tsx';
import { askMonarch, Button, LoadError, Loading, Modal, relTime, StateBlock, useConfirm } from '../mail/kit.tsx';
import { plainExcerpt, renderMarkdown } from './md.ts';
import { resolveLink, type GNode } from '../graph/model.ts';

export const MD_CLASS = [
  'md',
  '[&_a.md-wikilink]:no-underline [&_a.md-wikilink]:text-fg [&_a.md-wikilink]:border-b [&_a.md-wikilink]:border-fg-3 [&_a.md-wikilink]:cursor-pointer',
  '[&_a.md-wikilink:hover]:border-red',
  '[&_a.md-ghost]:text-fg-3 [&_a.md-ghost]:border-dashed',
  '[&_.md-tag]:font-mono [&_.md-tag]:text-[11px] [&_.md-tag]:text-fg-2 [&_.md-tag]:cursor-pointer [&_.md-tag:hover]:text-fg',
  '[&_li:has(>.md-task)]:list-none [&_li:has(>.md-task)]:-ml-4',
  '[&_.md-task]:inline-block [&_.md-task]:w-2.5 [&_.md-task]:h-2.5 [&_.md-task]:border [&_.md-task]:border-fg-3 [&_.md-task]:mr-2 [&_.md-task]:align-[-1px]',
  '[&_.md-task-done]:bg-fg-2 [&_.md-task-done]:border-fg-2',
  '[&_mark]:bg-subtle [&_mark]:text-fg [&_hr]:border-line [&_hr]:my-3 [&_del]:text-fg-3',
].join(' ');

export function encodeNoteId(id: string): string {
  return encodeURIComponent(id);
}
export function openNote(id: string): void {
  navigate(`memory/${encodeNoteId(id)}`);
}

/* ───────────────────────── list ───────────────────────── */

export function NoteList(props: { demoNodes?: GNode[] | null; onNew: () => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 200);
    return () => window.clearTimeout(t);
  }, [q]);
  const res = useResource<MemoryNoteSummary[]>(props.demoNodes ? null : `/memory/notes${qs({ q: debounced })}`, ['memory']);
  const notes: MemoryNoteSummary[] = useMemo(() => {
    if (props.demoNodes) {
      const t = debounced.toLowerCase();
      return props.demoNodes
        .filter((n) => n.kind === 'note' && (!t || n.title.toLowerCase().includes(t) || n.id.toLowerCase().includes(t)))
        .map((n) => ({ id: n.id, title: n.title, tags: n.tags, excerpt: 'Generated demo note.', updatedAt: new Date().toISOString(), linkCount: n.degree }));
    }
    const list = Array.isArray(res.data) ? res.data.filter((n) => n && typeof n.id === 'string') : [];
    return [...list].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  }, [res.data, props.demoNodes, debounced]);
  useEffect(() => setCursor(0), [debounced]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(notes.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter' && notes[cursor]) {
      e.preventDefault();
      openNote(notes[cursor].id);
    }
  };

  return (
    <div class="flex flex-col h-full min-h-0">
      <div class="flex items-baseline gap-2 px-4 pt-4 pb-2">
        <h2 class="ds-label">Notes</h2>
        <span class="text-[12px] text-fg-3">{notes.length}</span>
      </div>
      <div class="flex items-center gap-2 px-3 pb-2">
        <label class="relative flex-1">
          <Search size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" />
          <input
            class="w-full bg-transparent border border-line rounded-full pl-8 pr-3 py-2 text-[13px] text-fg placeholder:text-fg-3 outline-none focus:border-[#6a6a70] transition-colors"
            placeholder="Search notes"
            title="↑↓ to move, Enter to open"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={onKey}
            aria-label="Search notes"
            data-note-search
          />
        </label>
        <Btn pill size="sm" variant="ghost" onClick={props.onNew} title="New note (n)">
          <FilePlus size={13} /> New
        </Btn>
      </div>
      <div ref={listRef} class="flex-1 min-h-0 overflow-y-auto px-1.5 pb-3" role="listbox" aria-label="Notes">
        {res.error && !notes.length ? (
          <LoadError error={res.error} onRetry={res.reload} />
        ) : res.loading && !res.data && !props.demoNodes ? (
          <Skeleton lines={6} class="px-3 py-3" />
        ) : !notes.length ? (
          debounced ? (
            <StateBlock title="No matches">{`Nothing matches “${debounced}”.`}</StateBlock>
          ) : (
            <EmptyState
              icon={<FilePlus size={18} strokeWidth={1.5} />}
              title="No notes yet"
              hint="Write a note, or tell Monarch about yourself. It writes notes here as it learns."
              actions={
                <>
                  <Btn pill variant="primary" size="sm" onClick={props.onNew}>
                    <FilePlus size={13} /> Write your first note
                  </Btn>
                  <Btn pill size="sm" onClick={() => askMonarch('Interview me briefly about myself (work, routines, preferences) and save what you learn to my memory.')}>
                    <Sparkles size={13} /> Tell Monarch about yourself
                  </Btn>
                </>
              }
            />
          )
        ) : (
          notes.map((n, i) => (
            <button
              key={n.id}
              data-idx={i}
              role="option"
              aria-selected={i === cursor}
              class={`w-full text-left px-3 py-3 rounded-[var(--radius-control)] transition-colors ${i === cursor ? 'bg-white/[0.04]' : ''}`}
              onClick={() => openNote(n.id)}
              onMouseEnter={() => setCursor(i)}
            >
              <div class="flex items-baseline gap-2">
                <span class="text-[13.5px] font-medium text-fg truncate">{n.title || n.id}</span>
                <span class="ml-auto font-mono text-[11px] text-fg-3 shrink-0">{relTime(n.updatedAt)}</span>
              </div>
                            {n.excerpt && <div class="text-[12.5px] text-fg-3 mt-0.5 line-clamp-2 leading-relaxed">{plainExcerpt(n.excerpt, 160)}</div>}
              {(n.tags?.length > 0 || n.linkCount > 0) && (
                <div class="flex items-center gap-2 mt-1.5 text-[11.5px] text-fg-3">
                  {(n.tags ?? []).slice(0, 4).map((t) => (
                    <span key={t}>#{t}</span>
                  ))}
                  {n.linkCount > 0 && (
                    <span class="ml-auto inline-flex items-center gap-1">
                      <Link2 size={10} /> {n.linkCount}
                    </span>
                  )}
                </div>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── reader / editor ───────────────────────── */

export function NoteView(props: {
  id: string;
  nodes: GNode[];
  demo?: MemoryNote | null;
  onTag: (tag: string) => void;
  onLocate: (id: string) => void;
}) {
  const path = props.demo ? null : `/memory/notes/${encodeNoteId(props.id)}`;
  const res = useResource<MemoryNote>(path, ['memory']);
  const note = props.demo ?? res.data;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ title: string; tags: string; body: string; base?: string }>({ title: '', tags: '', body: '' });
  const [saving, setSaving] = useState(false);
  const [dialog, confirm] = useConfirm();
  const notFound = res.error && /not found|404/i.test(res.error);

  // leave edit mode when switching notes
  useEffect(() => setEditing(false), [props.id]);

  const startEdit = (n?: MemoryNote | null) => {
    const src = n ?? note;
    setDraft({
      title: src?.title ?? props.id.split('/').pop() ?? props.id,
      tags: (src?.tags ?? []).join(', '),
      body: src?.body ?? '',
      base: src?.updatedAt,
    });
    setEditing(true);
  };

  const exists = (target: string) => !!resolveLink(target, props.nodes);
  const html = useMemo(() => (note ? renderMarkdown(note.body ?? '', { exists }) : ''), [note?.body, props.nodes]);

  const save = async () => {
    if (props.demo) return toast('Demo mode — writes are disabled', 'warn');
    setSaving(true);
    try {
      const tags = draft.tags
        .split(/[,\s]+/)
        .map((t) => t.replace(/^#/, '').trim())
        .filter(Boolean);
      const saved = await api.put<MemoryNote>(`/memory/notes/${encodeNoteId(props.id)}`, { title: draft.title.trim() || undefined, body: draft.body, tags });
      if (saved && typeof saved === 'object') res.setData(saved);
      setEditing(false);
      toast('Note saved', 'success');
    } catch (e: any) {
      toast(`Save failed: ${e?.message ?? e}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    const dirty = note ? draft.body !== (note.body ?? '') || draft.title !== note.title : draft.body.trim() !== '';
    if (dirty && !(await confirm({ title: 'Discard changes?', body: 'Your edits to this note will be lost.', confirmLabel: 'Discard' }))) return;
    setEditing(false);
  };

  const remove = async () => {
    if (props.demo) return toast('Demo mode — writes are disabled', 'warn');
    if (!(await confirm({ title: 'Delete note', body: `Delete “${note?.title ?? props.id}” from the vault? This removes the markdown file.`, confirmLabel: 'Delete', danger: true })))
      return;
    try {
      await api.del(`/memory/notes/${encodeNoteId(props.id)}`);
      toast('Note deleted', 'success');
      navigate('memory');
    } catch (e: any) {
      toast(`Delete failed: ${e?.message ?? e}`, 'error');
    }
  };

  const onBodyClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-wikilink],[data-tag],[data-external]') as HTMLElement | null;
    if (!el) return;
    e.preventDefault();
    if (el.dataset.wikilink !== undefined) {
      const target = el.dataset.wikilink ?? '';
      openNote(resolveLink(target, props.nodes) ?? target);
    } else if (el.dataset.tag) props.onTag(el.dataset.tag);
    else if (el.dataset.external) void openExternal(el.dataset.external);
  };

  const titleOf = (id: string) => props.nodes.find((n) => n.id === id)?.title ?? id.split('/').pop() ?? id;

  const header = (
    <div class="flex items-center gap-0.5 px-3 pt-3 pb-1">
      <button class="p-1.5 rounded-[var(--radius-control)] text-fg-3 hover:text-fg hover:bg-subtle" onClick={() => navigate('memory')} title="All notes (Esc)" aria-label="Back to all notes">
        <ArrowLeft size={14} />
      </button>
      <span class="text-[12px] text-fg-3 truncate flex-1 px-1" title={props.id}>
        {props.id}
      </span>
      {note && !editing && (
        <>
          <button class="p-1.5 rounded-[var(--radius-control)] text-fg-3 hover:text-fg hover:bg-subtle" title="Locate in graph" aria-label="Locate in graph" onClick={() => props.onLocate(props.id)}>
            <Crosshair size={13} />
          </button>
          <button
            class="p-1.5 rounded-[var(--radius-control)] text-fg-3 hover:text-fg hover:bg-subtle"
            title="Ask Monarch to enrich & link this note"
            aria-label="Ask Monarch about this note"
            onClick={() =>
              askMonarch(
                `Review my memory note "${props.id}". Summarize it, suggest related notes to link with [[wikilinks]], and point out anything outdated. Don't modify the note unless I confirm.`,
              )
            }
          >
            <Sparkles size={13} />
          </button>
          <button class="p-1.5 rounded-[var(--radius-control)] text-fg-3 hover:text-fg hover:bg-subtle" title="Edit (e)" aria-label="Edit note" onClick={() => startEdit()}>
            <Pencil size={13} />
          </button>
          <button class="p-1.5 rounded-[var(--radius-control)] text-fg-3 hover:text-red hover:bg-subtle" title="Delete" aria-label="Delete note" onClick={remove}>
            <Trash size={13} />
          </button>
        </>
      )}
    </div>
  );

  // keyboard: e = edit, Esc = back / cancel, Ctrl+S = save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
      if (editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if (e.key === 'Escape' && editing) {
        e.preventDefault();
        void cancel();
      } else if (!typing && !editing && e.key === 'e' && note && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        startEdit();
      } else if (!typing && !editing && e.key === 'Escape') {
        navigate('memory');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (editing) {
    return (
      <div class="flex flex-col h-full min-h-0">
        {header}
        <div class="px-4 py-3 flex flex-col gap-2 flex-1 min-h-0">
          <input
            class="hud-input text-[17px]! font-semibold"
            value={draft.title}
            placeholder="Title"
            aria-label="Title"
            onInput={(e) => setDraft({ ...draft, title: (e.target as HTMLInputElement).value })}
          />
          <input
            class="hud-input font-mono text-xs!"
            value={draft.tags}
            placeholder="tags, comma separated"
            aria-label="Tags"
            onInput={(e) => setDraft({ ...draft, tags: (e.target as HTMLInputElement).value })}
          />
          <textarea
            class="hud-input font-mono text-[13px]! leading-[1.7] flex-1 min-h-40 resize-none"
            value={draft.body}
            placeholder={'# Heading\n\nWrite markdown. Link notes with [[Note name]], tag with #tag.'}
            aria-label="Markdown body"
            onInput={(e) => setDraft({ ...draft, body: (e.target as HTMLTextAreaElement).value })}
            autoFocus
          />
          {note && draft.base && note.updatedAt !== draft.base && (
            <div class="text-[12px] text-warning">Note changed on disk while editing — saving will overwrite it.</div>
          )}
        </div>
        <div class="flex items-center gap-2 px-4 py-3">
          <span class="text-[11.5px] text-fg-3">Ctrl+S to save · Esc to cancel</span>
          <Btn pill variant="ghost" size="xs" class="ml-auto" onClick={cancel}>
            Cancel
          </Btn>
          <Btn pill variant="primary" size="xs" loading={saving} onClick={save}>
            Save
          </Btn>
        </div>
        {dialog}
      </div>
    );
  }

  return (
    <div class="flex flex-col h-full min-h-0">
      {header}
      <div class="flex-1 min-h-0 overflow-y-auto">
        {!note && notFound ? (
          <StateBlock title="This note doesn’t exist yet">
            <div>
              <span class="font-mono text-fg-2">{props.id}</span> is linked but has no file.
            </div>
            <div class="mt-3">
              <Btn pill size="xs" variant="primary" onClick={() => startEdit(null)}>
                <FilePlus size={12} /> Create it
              </Btn>
            </div>
          </StateBlock>
        ) : !note && res.error ? (
          <LoadError error={res.error} onRetry={res.reload} />
        ) : !note ? (
          <Skeleton lines={8} class="max-w-[68ch] mx-auto px-5 sm:px-6 pt-4" />
        ) : (
          <article class="max-w-[68ch] mx-auto px-5 sm:px-6 pt-2 pb-10">
            <h1 class="text-[21px] text-fg font-semibold tracking-[-0.01em] leading-snug">{note.title || props.id}</h1>
            <div class="flex flex-wrap items-center gap-1.5 mt-2.5">
              {note.source === 'agent' && <Tag title="Written by Monarch">agent</Tag>}
              {(note.tags ?? []).map((t) => (
                <button key={t} class="text-[11.5px] rounded-full bg-subtle px-2 py-0.5 text-fg-2 hover:text-fg transition-colors" onClick={() => props.onTag(t)} title={`Highlight #${t} in graph`}>
                  #{t}
                </button>
              ))}
              <span class="ml-auto text-[11.5px] text-fg-3" title={note.updatedAt}>
                updated {relTime(note.updatedAt)}
              </span>
            </div>
            {note.body?.trim() ? (
              <div class={`${MD_CLASS} mt-5 text-[14.5px] leading-[1.7]`} onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <div class="mt-5 text-[13px] text-fg-3">
                Empty note.{' '}
                <button class="underline decoration-fg-3 underline-offset-2 text-fg-2 hover:text-fg" onClick={() => startEdit()}>
                  Write something
                </button>
              </div>
            )}
            <LinkList title="Backlinks" ids={note.backlinks ?? []} titleOf={titleOf} empty="No notes link here yet." />
            <LinkList
              title="Outgoing"
              ids={(note.links ?? []).map((l) => resolveLink(l, props.nodes) ?? l)}
              titleOf={titleOf}
              empty="No outgoing links."
              ghost={(id) => !resolveLink(id, props.nodes)}
            />
          </article>
        )}
      </div>
      {dialog}
    </div>
  );
}

function LinkList(props: { title: string; ids: string[]; titleOf: (id: string) => string; empty: string; ghost?: (id: string) => boolean }) {
  const ids = [...new Set(props.ids.filter((x) => typeof x === 'string' && x))];
  return (
    <section class="mt-8">
      <div class="text-[12px] text-fg-3 flex items-center gap-2">
        {props.title} <span class="text-fg-3">{ids.length}</span>
      </div>
      {ids.length ? (
        <ul class="mt-1.5">
          {ids.map((id) => {
            const ghost = props.ghost?.(id) ?? false;
            return (
              <li key={id}>
                <button class="group w-full flex items-center gap-2.5 text-left px-2 py-1.5 rounded-[var(--radius-control)] text-[13px] hover:bg-raised transition-colors" onClick={() => openNote(id)}>
                  <span class={`inline-block w-1.5 h-1.5 shrink-0 ${ghost ? 'border border-fg-3' : 'bg-fg-2'} rounded-full`} />
                  <span class={`truncate ${ghost ? 'text-fg-3' : 'text-fg-2'}`}>{props.titleOf(id)}</span>
                  <span class="ml-auto text-[11px] text-fg-3 truncate max-w-[45%] opacity-0 group-hover:opacity-100">{id}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div class="text-[12.5px] text-fg-3 mt-1.5 px-2">{props.empty}</div>
      )}
    </section>
  );
}

/* ───────────────────────── new note modal ───────────────────────── */

export function NewNoteModal(props: { open: boolean; onClose: () => void; nodes: GNode[]; demo?: boolean }) {
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (props.open) {
      setPath('');
      setTitle('');
    }
  }, [props.open]);
  const id = path.trim().replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  const clash = !!id && props.nodes.some((n) => n.kind === 'note' && n.id.toLowerCase() === id.toLowerCase());
  const invalid = !id || /(^|\/)\.\.?(\/|$)/.test(id) || /[\\:*?"<>|]/.test(id);

  const create = async () => {
    if (invalid || clash) return;
    if (props.demo) return toast('Demo mode — writes are disabled', 'warn');
    setBusy(true);
    try {
      const t = title.trim() || id.split('/').pop() || id;
      await api.put<MemoryNote>(`/memory/notes/${encodeNoteId(id)}`, { title: t, body: `# ${t}\n\n`, tags: [] });
      props.onClose();
      openNote(id);
      toast('Note created', 'success');
    } catch (e: any) {
      toast(`Create failed: ${e instanceof ApiError ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="New note"
      footer={
        <>
          <Btn pill variant="ghost" onClick={props.onClose}>
            Cancel
          </Btn>
          <Button variant="primary" loading={busy} disabled={invalid || clash} onClick={create}>
            Create
          </Button>
        </>
      }
    >
      <form
        class="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label class="flex flex-col gap-1.5">
          <span class="text-[12.5px] text-fg-2">Where to save it</span>
          <input class="hud-input font-mono text-[13px]!" placeholder="People/Pepper Potts" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
          <span class="text-[11px] text-fg-3">Folders with “/”. Saved as markdown — {id ? <span class="font-mono text-fg-2">{id}.md</span> : '…'}</span>
          {clash && <span class="text-[12px] text-warning">A note with this path already exists.</span>}
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-[12.5px] text-fg-2">Title</span>
          <input class="hud-input" placeholder={id.split('/').pop() || 'Title'} value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        </label>
        <button type="submit" class="hidden" />
      </form>
    </Modal>
  );
}
