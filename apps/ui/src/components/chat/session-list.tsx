/** Session list rows with inline rename + confirm-delete. Used by Comms and Workshop. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionSummary } from '@monarch/shared';
import { Pencil, Trash2, Check, X } from 'lucide-preact';
import { deleteSession, renameSession } from '../../lib/chat-store.ts';
import { toast } from '../../lib/store.ts';
import { fmt } from '../ui.tsx';

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

  if (mode === 'rename') {
    return (
      <div class="hud-row" data-active={props.active ? 'true' : 'false'}>
        <input
          ref={input}
          class="flex-1 min-w-0 bg-[#121213] border border-fg-3 px-2 py-0.5 text-[13px] outline-none"
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
      <div class="hud-row bg-red/[0.06]" data-active={props.active ? 'true' : 'false'}>
        <span class="flex-1 min-w-0 truncate text-[12px] text-fg-2">Delete “{s.title}”?</span>
        <button class="text-red hover:text-fg p-0.5" title="Confirm delete" onClick={() => void doDelete()} disabled={busy} autoFocus>
          <Check size={13} />
        </button>
        <button class="text-fg-3 hover:text-fg p-0.5" title="Cancel" onClick={() => setMode('view')}>
          <X size={13} />
        </button>
      </div>
    );
  }

  return (
    <a
      href={props.href}
      class="hud-row group items-start"
      data-active={props.active ? 'true' : 'false'}
      onDblClick={(e) => {
        e.preventDefault();
        setMode('rename');
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2') setMode('rename');
        if (e.key === 'Delete') setMode('delete');
      }}
    >
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5">
          {s.running && <span class="inline-block w-1.5 h-1.5 bg-red hud-blink shrink-0" title="Running" />}
          <span class={`truncate text-[13px] ${props.active ? 'text-fg' : 'text-fg-2'}`}>{s.title || 'Untitled'}</span>
        </div>
        <div class="font-mono text-[10px] text-fg-3 mt-0.5 truncate">
          {props.sub ?? `${s.engine === 'claude-sdk' ? 'claude' : 'pi'} · ${s.model || '—'} · ${s.itemCount} items`}
        </div>
      </div>
      <div class="shrink-0 flex flex-col items-end gap-1">
        <span class="font-mono text-[10px] text-fg-3 tabular-nums">{fmt.ago(s.updatedAt)}</span>
        <span class="hidden group-hover:flex group-focus-within:flex items-center gap-1">
          <button
            class="text-fg-3 hover:text-fg"
            title="Rename (F2)"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMode('rename');
            }}
          >
            <Pencil size={11} strokeWidth={1.5} />
          </button>
          <button
            class="text-fg-3 hover:text-red"
            title="Delete"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMode('delete');
            }}
          >
            <Trash2 size={11} strokeWidth={1.5} />
          </button>
        </span>
      </div>
    </a>
  );
}

/** mono segmented control used for filter tabs */
export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void; class?: string }) {
  return (
    <div class={`flex border border-line ${props.class ?? ''}`} role="tablist">
      {props.options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={props.value === o.value}
          class={`flex-1 px-2 h-7 whitespace-nowrap font-mono text-[10px] tracking-[0.14em] uppercase border-r border-line last:border-r-0 ${
            props.value === o.value ? 'bg-subtle text-fg' : 'text-fg-3 hover:text-fg-2'
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
