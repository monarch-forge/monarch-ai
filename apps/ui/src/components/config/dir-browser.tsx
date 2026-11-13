/** Directory picker modal backed by GET /api/fs/dirs?path= (used by Workshop + Config). */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowUp, Folder, CornerDownLeft } from 'lucide-preact';
import { api, qs } from '../../lib/api.ts';
import { Spinner, ErrorLine, Empty } from '../ui.tsx';

interface DirListing {
  path: string;
  parent: string | null;
  dirs: string[];
}

function join(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
}

export function DirBrowser(props: { open: boolean; initialPath?: string; title?: string; confirmLabel?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const go = async (path: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const l = await api.get<DirListing>(`/fs/dirs${qs({ path })}`);
      setListing(l);
      setPathInput(l.path);
      setFilter('');
      listRef.current?.scrollTo({ top: 0 });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (props.open) void go(props.initialPath ?? '');
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open]);

  if (!props.open) return null;
  const dirs = (listing?.dirs ?? []).filter((d) => (showHidden || !d.startsWith('.')) && (!filter || d.toLowerCase().includes(filter.toLowerCase())));

  return (
    <div class="modal modal-open" role="dialog" aria-modal="true" aria-label={props.title ?? 'Choose folder'}>
      <div class="modal-box hud-panel p-0 max-w-xl w-[calc(100vw-2rem)] rounded-[2px] bg-surface flex flex-col max-h-[80vh]">
        <header class="hud-head">
          <span class="hud-code">FS.01</span>
          <h2 class="hud-title">{props.title ?? 'Choose folder'}</h2>
          {loading && <Spinner class="ml-auto" />}
        </header>
        <div class="p-3 flex gap-2 border-b border-line">
          <button
            class="btn btn-sm btn-outline border-line rounded-[2px] text-fg-2 hover:bg-subtle px-2"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void go(listing.parent)}
            title="Parent folder"
          >
            <ArrowUp size={13} />
          </button>
          <input
            class="input input-sm flex-1 bg-[#121213] border-line font-mono text-[12px] focus:outline-none focus:border-fg-3"
            value={pathInput}
            onInput={(e) => setPathInput((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && void go(pathInput)}
            spellcheck={false}
            aria-label="Path"
          />
          <button class="btn btn-sm btn-outline border-line rounded-[2px] text-fg-2 hover:bg-subtle px-2" onClick={() => void go(pathInput)} title="Go">
            <CornerDownLeft size={13} />
          </button>
        </div>
        <div class="px-3 pt-2 flex items-center gap-3">
          <input
            class="flex-1 bg-transparent outline-none text-[12px] placeholder:text-fg-3 border-b border-line py-1 focus:border-fg-3"
            placeholder="Filter…"
            value={filter}
            onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          />
          <label class="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3 cursor-pointer">
            <input type="checkbox" class="checkbox checkbox-xs rounded-[2px]" checked={showHidden} onChange={(e) => setShowHidden((e.target as HTMLInputElement).checked)} />
            hidden
          </label>
        </div>
        <div ref={listRef} class="flex-1 min-h-[240px] overflow-y-auto py-1.5 px-1.5">
          <ErrorLine error={error} />
          {listing && !dirs.length && !loading && <Empty>No subfolders</Empty>}
          {dirs.map((d) => (
            <button key={d} class="hud-row w-full text-left" onClick={() => listing && void go(join(listing.path, d))} onDblClick={() => listing && props.onPick(join(listing.path, d))}>
              <Folder size={13} strokeWidth={1.5} class="text-fg-3 shrink-0" />
              <span class="truncate text-[13px] text-fg-2">{d}</span>
            </button>
          ))}
        </div>
        <div class="flex items-center gap-2 p-3 border-t border-line">
          <span class="font-mono text-[11px] text-fg-3 truncate flex-1" title={listing?.path}>
            {listing?.path ?? ''}
          </span>
          <button class="btn btn-sm btn-ghost rounded-[2px] font-mono font-normal uppercase tracking-wider text-[11px] text-fg-2" onClick={props.onClose}>
            Cancel
          </button>
          <button class="btn btn-sm btn-primary rounded-[2px] font-mono font-normal uppercase tracking-wider text-[11px]" disabled={!listing} onClick={() => listing && props.onPick(listing.path)}>
            {props.confirmLabel ?? 'Select folder'}
          </button>
        </div>
      </div>
      <div class="modal-backdrop bg-black/50" onClick={props.onClose} />
    </div>
  );
}
