/**
 * Calm chat shell shared by Chat and Workshop: a slim session sidebar (drawer on narrow screens), a quiet header,
 * the transcript as the hero, an optional always-on right rail (Chat: threads) and an optional "details" column hidden by default.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { PanelLeft, PanelRight, X, ListTodo } from 'lucide-preact';
import { Drawer } from '../ui.tsx';

/** boolean persisted per viewer (localStorage, best effort) */
export function useStoredFlag(key: string, initial = false): [boolean, (v: boolean) => void] {
  const [v, setV] = useState<boolean>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : s === '1';
    } catch {
      return initial;
    }
  });
  return [
    v,
    (n) => {
      setV(n);
      try {
        localStorage.setItem(key, n ? '1' : '0');
      } catch {
        /* ignore */
      }
    },
  ];
}

export const ICON_BTN =
  'inline-flex items-center justify-center w-8 h-8 rounded-[6px] text-fg-3 hover:text-fg hover:bg-[var(--bg-raised,#202023)] transition-colors duration-150 disabled:opacity-40';

export function ChatLayout(props: {
  sidebar: ComponentChildren;
  /** header title area */
  title: ComponentChildren;
  /** small quiet actions at the right of the header (before the details toggle) */
  actions?: ComponentChildren;
  /** content of the details column; omit to hide the toggle */
  details?: ComponentChildren;
  detailsOpen?: boolean;
  onDetails?: (open: boolean) => void;
  /** always-visible right column on wide windows (>= 1100px); a header button opens it in a drawer below */
  rail?: ComponentChildren;
  /** drawer title / toggle label for `rail` */
  railTitle?: string;
  /** a route change (e.g. session id) closes the mobile sidebar */
  routeKey?: string | null;
  children: ComponentChildren;
}) {
  const [side, setSide] = useState(false);
  useEffect(() => setSide(false), [props.routeKey]);
  // the remembered "details open" applies to the wide column only; below xl it's a transient drawer
  const wide = useMedia('(min-width: 1280px)');
  const [drawer, setDrawer] = useState(false);
  const open = wide ? !!props.detailsOpen : drawer;
  const setOpen = (v: boolean) => (wide ? props.onDetails?.(v) : setDrawer(v));
  const railWide = useMedia('(min-width: 1100px)');
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => setRailOpen(false), [props.routeKey, railWide]);

  return (
    <div class="h-full flex min-h-0 relative">
      {/* sidebar: column on md+, drawer below */}
      {side && <div class="sm:hidden fixed inset-0 z-40 bg-black/50" onClick={() => setSide(false)} />}
      <aside
        class={`flex-col min-h-0 bg-[var(--bg-surface)] w-[260px] shrink-0 ${
          side ? 'flex fixed inset-y-0 left-0 z-50 w-[86vw] max-w-[300px] shadow-[0_12px_32px_rgb(0_0_0/.45)]' : 'hidden sm:flex sm:border-r sm:border-dashed sm:border-[var(--border-default)] sm:bg-transparent'
        }`}
      >
        {side && (
          <div class="sm:hidden flex items-center h-12 pl-4 pr-2 shrink-0">
            <span class="text-[13px] font-semibold text-fg">Sessions</span>
            <button class={`${ICON_BTN} ml-auto`} onClick={() => setSide(false)} aria-label="Close sessions">
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>
        )}
        {props.sidebar}
      </aside>

      {/* main */}
      <main class="flex-1 min-w-0 flex flex-col min-h-0">
        <header class="h-14 shrink-0 flex items-center gap-2 px-3 md:px-6">
          <button class={`${ICON_BTN} sm:hidden -ml-1`} onClick={() => setSide(true)} aria-label="Show sessions" title="Sessions">
            <PanelLeft size={17} strokeWidth={1.75} />
          </button>
          <div class="flex-1 min-w-0 flex items-center gap-2">{props.title}</div>
          {props.actions}
          {props.rail !== undefined && !railWide && (
            <button class={ICON_BTN} onClick={() => setRailOpen(true)} title={props.railTitle ?? 'Threads'} aria-label={props.railTitle ?? 'Threads'}>
              <ListTodo size={17} strokeWidth={1.75} />
            </button>
          )}
          {props.details !== undefined && (
            <button
              class={`${ICON_BTN} ${open ? 'text-fg bg-[var(--bg-raised,#202023)]' : ''}`}
              onClick={() => setOpen(!open)}
              title={open ? 'Hide details' : 'Show details'}
              aria-pressed={open}
            >
              <PanelRight size={17} strokeWidth={1.75} />
            </button>
          )}
        </header>
        <div class="flex-1 min-h-0 flex flex-col">{props.children}</div>
      </main>

      {/* rail: column from 1100px, right drawer below */}
      {props.rail !== undefined &&
        (railWide ? (
          <aside class="w-[320px] shrink-0 border-l border-dashed border-[var(--border-default)] flex flex-col min-h-0">
            <div class="flex-1 min-h-0 overflow-y-auto px-[22px] py-[26px] flex flex-col gap-6">{props.rail}</div>
          </aside>
        ) : (
          <Drawer open={railOpen} onClose={() => setRailOpen(false)} side="right" title={props.railTitle ?? 'Threads'}>
            <div class="px-4 pb-5 flex flex-col gap-6">{props.rail}</div>
          </Drawer>
        ))}

      {/* details: column on xl, drawer below */}
      {props.details !== undefined && open && (
        <>
          <div class="xl:hidden fixed inset-0 z-40 bg-black/40" onClick={() => setOpen(false)} />
          <aside class="fixed xl:static inset-y-0 right-0 z-50 w-[86vw] max-w-[320px] xl:w-[300px] shrink-0 bg-[var(--bg-surface)] xl:bg-transparent xl:border-l xl:border-dashed xl:border-[var(--border-default)] shadow-[0_12px_32px_rgb(0_0_0/.45)] xl:shadow-none flex flex-col min-h-0">
            <div class="flex items-center h-12 px-4 shrink-0">
              <span class="text-[13px] font-semibold text-fg">Details</span>
              <button class={`${ICON_BTN} ml-auto -mr-1.5`} onClick={() => setOpen(false)} aria-label="Close details">
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
            <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-5 flex flex-col gap-6">{props.details}</div>
          </aside>
        </>
      )}
    </div>
  );
}

function useMedia(q: string): boolean {
  const get = () => (typeof matchMedia === 'function' ? matchMedia(q).matches : true);
  const [m, setM] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    // some webviews/emulators skip MediaQueryList change events on resize
    window.addEventListener('resize', on);
    return () => {
      mq.removeEventListener('change', on);
      window.removeEventListener('resize', on);
    };
  }, [q]);
  return m;
}

/** a quiet sidebar section label (sentence case) */
export function SideLabel(props: { children: ComponentChildren; right?: ComponentChildren }) {
  return (
    <div class="flex items-center gap-2 px-3 pt-4 pb-1.5">
      <span class="text-[11.5px] font-medium text-fg-3">{props.children}</span>
      {props.right && <span class="ml-auto">{props.right}</span>}
    </div>
  );
}

/** status pill shown next to the conversation title while a turn runs */
export function LiveBadge(props: { running?: boolean; label?: string }) {
  if (!props.running) return null;
  return (
    <span class="inline-flex items-center gap-1.5 shrink-0 rounded-full bg-[var(--accent-dim)] px-2 py-0.5 text-[11px] text-fg-2">
      <span class="w-1.5 h-1.5 rounded-full bg-red hud-blink" />
      {props.label ?? 'Working'}
    </span>
  );
}

/** warm suggestion chips for empty states */
export function Suggestions(props: { items: string[]; onPick: (t: string) => void; disabled?: boolean }) {
  return (
    <div class="flex flex-wrap justify-center gap-2 max-w-[560px]">
      {props.items.map((t) => (
        <button
          key={t}
          class="rounded-full bg-[var(--bg-surface)] hover:bg-[var(--bg-raised,#202023)] px-3.5 py-1.5 text-[13px] text-fg-2 hover:text-fg transition-colors duration-150 disabled:opacity-50"
          onClick={() => props.onPick(t)}
          disabled={props.disabled}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
