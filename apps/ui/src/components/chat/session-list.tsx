/** Session list rows with inline rename + confirm-delete. Used by Beru and Workshop. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionSummary } from '@monarch/shared';
import { Pencil, Trash2, X } from 'lucide-preact';
import { deleteSession, renameSession } from '../../lib/chat-store.ts';
import { toast } from '../../lib/store.ts';
import { fmt } from '../ui.tsx';
import { ContextMeter } from './meta.tsx';
import { settings } from '../../lib/store.ts';

export function SessionRow(props: { s: SessionSummary; active: boolean; href: string; onDeleted?: (id: string) => void; sub?: string }) {
  const { s } = props;
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [title, setTitle] = useState(s.title);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'rename') {
      setTitle(s.title);
      requestAnimationFrame(() => input.current?.select());
    }
  }, [mode]);

  const saveTitle = async () => {
    const t = title.trim();
    if (!t || t === s.title) return setMode('view');
    setBusy(true);
    try {
      await renameSession(s.id, t);
      setMode('view');
    } catch (e: any) {
      toast(`Rename failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await deleteSession(s.id);
      props.onDeleted?.(s.id);
    } catch (e: any) {
      toast(`Delete failed: ${e?.message ?? e}`, 'error');
      setMode('view');
    } finally {
      setBusy(false);
    }
  };

  const rowBase = `relative flex items-center gap-2 mx-2 px-3 py-2.5 rounded-[8px] transition-colors duration-150 ${
    props.active ? 'bg-[var(--bg-raised,#202023)]' : 'hover:bg-[var(--bg-raised,#202023)]'
  }`;
  const bar = props.active ? <span class="absolute left-0 top-2.5 bottom-2.5 w-[2px] rounded-full bg-red" /> : null;

  if (mode === 'rename') {
    return (
      <div class={rowBase}>
        {bar}
        <input
          ref={input}
          class="flex-1 min-w-0 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[6px] px-2 py-1 text-[13px] text-fg outline-none"
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveTitle();
            if (e.key === 'Escape') setMode('view');
          }}
          onBlur={() => void saveTitle()}
          disabled={busy}
          aria-label="Session title"
        />
      </div>
    );
  }

  if (mode === 'delete') {
    return (
      <div class={`${rowBase} bg-red/[0.06]`}>
        <span class="flex-1 min-w-0 truncate text-[12.5px] text-fg-2">Delete this conversation?</span>
        <button class="rounded-[6px] px-2 py-0.5 text-[12px] text-red hover:bg-red/10" title="Delete for good" onClick={() => void doDelete()} disabled={busy} autoFocus>
          Delete
        </button>
        <button class="rounded-[6px] p-1 text-fg-3 hover:text-fg" title="Cancel" onClick={() => setMode('view')}>
          <X size={13} />
        </button>
      </div>
    );
  }

  const ctx = s.context?.window ? <ContextMeter context={s.context} autoCompactPercent={settings.value?.agent?.autoCompactPercent} compact /> : null;

  return (
    <a
      href={props.href}
      class={`group ${rowBase}`}
      title={s.title || 'Untitled'}
      onDblClick={(e) => {
        e.preventDefault();
        setMode('rename');
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2') setMode('rename');
        if (e.key === 'Delete') setMode('delete');
      }}
    >
      {bar}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          {s.running && <span class="w-1.5 h-1.5 rounded-full bg-red hud-blink shrink-0" title="Working" />}
          <span class={`truncate text-[13.5px] ${props.active ? 'text-fg' : 'text-fg-2 group-hover:text-fg'}`}>{s.title || 'Untitled'}</span>
        </div>
        {props.sub && <div class="text-[11.5px] text-fg-3 mt-0.5 truncate">{props.sub}</div>}
      </div>
      <span class="shrink-0 text-[11px] text-fg-3 tabular-nums group-hover:hidden group-focus-within:hidden">{fmt.ago(s.updatedAt)}</span>
      <span class="shrink-0 hidden group-hover:flex group-focus-within:flex items-center gap-0.5 text-[11px] text-fg-3">
        {ctx && <span class="mr-1">{ctx}</span>}
        <button
          class="p-1 rounded-[6px] hover:text-fg"
          title="Rename (F2)"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMode('rename');
          }}
        >
          <Pencil size={12} strokeWidth={1.75} />
        </button>
        <button
          class="p-1 rounded-[6px] hover:text-red"
          title="Delete"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMode('delete');
          }}
        >
          <Trash2 size={12} strokeWidth={1.75} />
        </button>
      </span>
    </a>
  );
}

/** soft pill segmented control used for filter tabs */
export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void; class?: string }) {
  return (
    <div class={`flex gap-1 p-1 rounded-[8px] bg-[var(--bg-primary)] ${props.class ?? ''}`} role="tablist">
      {props.options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={props.value === o.value}
          class={`flex-1 px-2 h-7 whitespace-nowrap rounded-[6px] text-[12.5px] transition-colors duration-150 ${
            props.value === o.value ? 'bg-[var(--bg-raised,#202023)] text-fg' : 'text-fg-3 hover:text-fg-2'
          }`}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && <span class="ml-1.5 text-fg-3">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
