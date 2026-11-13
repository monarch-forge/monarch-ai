/**
 * Command palette — Ctrl/Cmd+K (or "/" when not typing). Fuzzy-filters navigation targets and actions,
 * and offers "Ask Monarch: <query>" which starts a new chat and jumps to Comms.
 * OWNED BY UI-A.
 */
import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import {
  Activity,
  Bell,
  CalendarDays,
  CornerDownLeft,
  Hash,
  LayoutGrid,
  Mail,
  MessageSquare,
  MessageSquarePlus,
  Network,
  Search,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Volume2,
  VolumeX,
  Wrench,
} from 'lucide-preact';
import type { Settings } from '@monarch/shared';
import { api } from '../lib/api.ts';
import { conn, navigate, settings, toast } from '../lib/store.ts';
import { stopSpeaking } from '../lib/voice.ts';
import { notificationsOpen } from './notifications.tsx';
import { sendNewChat } from './overview/console-store.ts';

export const paletteOpen = signal(false);

interface Item {
  id: string;
  group: 'Ask' | 'Navigate' | 'Actions';
  label: string;
  hint?: string;
  keywords?: string;
  icon: LucideIcon;
  run: () => void | Promise<void>;
}

const PAGES: { id: string; label: string; icon: LucideIcon; keywords: string }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid, keywords: 'home dashboard hud' },
  { id: 'comms', label: 'Comms', icon: MessageSquare, keywords: 'chat sessions conversations' },
  { id: 'workshop', label: 'Workshop', icon: Wrench, keywords: 'coding code terminal' },
  { id: 'mail', label: 'Mail', icon: Mail, keywords: 'gmail inbox email' },
  { id: 'slack', label: 'Slack', icon: Hash, keywords: 'channels messages' },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays, keywords: 'calendar tasks events automations schedule' },
  { id: 'memory', label: 'Memory', icon: Network, keywords: 'vault notes graph obsidian' },
  { id: 'systems', label: 'Systems', icon: Activity, keywords: 'cpu memory processes telemetry machine' },
  { id: 'config', label: 'Config', icon: SlidersHorizontal, keywords: 'settings providers models accounts preferences' },
];

/** subsequence fuzzy score; higher is better, -1 = no match */
function score(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) return 1000 - t.length;
  if (idx > 0) return (t[idx - 1] === ' ' ? 800 : 600) - idx;
  let ti = 0;
  let s = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    run = found === ti ? run + 1 : 0;
    s += 10 + run * 5 - Math.min(found - ti, 10);
    if (found === 0 || t[found - 1] === ' ') s += 8;
    ti = found + 1;
  }
  return s;
}

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

async function toggleVoice() {
  const s = settings.value;
  if (!s) {
    toast('Settings unavailable — core offline', 'warn');
    return;
  }
  const next = !s.assistant.voice.speak;
  try {
    const updated = await api.put<Settings>('/settings', { assistant: { voice: { speak: next } } });
    if (updated) settings.value = updated;
    if (!next) stopSpeaking();
    toast(next ? 'Voice replies on' : 'Voice replies off', 'info');
  } catch (e: any) {
    toast(e?.message ?? 'Could not update voice setting', 'error');
  }
}

function askMonarch(q: string) {
  const text = q.trim();
  if (!text) return;
  if (conn.value !== 'open') toast('Core offline — question queued until the link is restored', 'warn');
  const { session } = sendNewChat(text);
  navigate('comms');
  session.then(
    (id) => {
      // only follow if the user is still waiting on Comms
      if (/^#\/comms\/?$/.test(location.hash)) navigate(`comms/${encodeURIComponent(id)}`);
    },
    () => {
      /* comms page shows newest session anyway */
    },
  );
}

export function CommandPalette() {
  const open = paletteOpen.value;
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        paletteOpen.value = !paletteOpen.value;
        return;
      }
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !paletteOpen.value && !isTyping(document.activeElement)) {
        e.preventDefault();
        paletteOpen.value = true;
      }
    };
    window.addEventListener('keydown', onKey);
    const onOpen = () => (paletteOpen.value = true);
    window.addEventListener('monarch:open-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('monarch:open-palette', onOpen);
    };
  }, []);

  // reset + focus on open, restore focus on close
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    setQ('');
    setSel(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => prev?.focus?.();
  }, [open]);

  const voiceOn = !!settings.value?.assistant.voice.speak;

  const items = useMemo<Item[]>(() => {
    const close = () => (paletteOpen.value = false);
    const nav: Item[] = PAGES.map((p) => ({
      id: `nav:${p.id}`,
      group: 'Navigate',
      label: p.label,
      hint: 'Go to',
      keywords: p.keywords,
      icon: p.icon,
      run: () => {
        close();
        navigate(p.id);
      },
    }));
    const actions: Item[] = [
      {
        id: 'act:new-chat',
        group: 'Actions',
        label: 'New chat',
        keywords: 'conversation session comms start',
        icon: MessageSquarePlus,
        run: () => {
          close();
          navigate('comms/new');
        },
      },
      {
        id: 'act:new-coding',
        group: 'Actions',
        label: 'New coding session',
        keywords: 'workshop code agent repo',
        icon: Terminal,
        run: () => {
          close();
          navigate('workshop');
        },
      },
      {
        id: 'act:voice',
        group: 'Actions',
        label: voiceOn ? 'Turn voice replies off' : 'Turn voice replies on',
        hint: 'Toggle voice',
        keywords: 'speech speak tts audio mute',
        icon: voiceOn ? VolumeX : Volume2,
        run: () => {
          close();
          void toggleVoice();
        },
      },
      {
        id: 'act:notifications',
        group: 'Actions',
        label: 'Open notifications',
        keywords: 'alerts inbox feed bell',
        icon: Bell,
        run: () => {
          close();
          notificationsOpen.value = true;
        },
      },
    ];
    const query = q.trim();
    const ranked = [...nav, ...actions]
      .map((it) => ({ it, s: query ? Math.max(score(query, it.label), score(query, `${it.label} ${it.keywords ?? ''}`) - 50) : 0 }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => (query ? b.s - a.s : 0))
      .map((x) => x.it);
    const ask: Item[] = query
      ? [
          {
            id: 'ask',
            group: 'Ask',
            label: query,
            hint: 'Ask Monarch',
            icon: Sparkles,
            run: () => {
              close();
              askMonarch(query);
            },
          },
        ]
      : [];
    // when the query matches commands well, put them first; otherwise lead with "Ask"
    const strong = query && ranked.length > 0 && score(query, ranked[0].label) >= 600;
    return strong ? [...ranked, ...ask] : [...ask, ...ranked];
  }, [q, voiceOn]);

  useEffect(() => {
    if (sel >= items.length) setSel(Math.max(0, items.length - 1));
  }, [items.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, open]);

  if (!open) return null;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      paletteOpen.value = false;
    } else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setSel((s) => (items.length ? (s + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setSel((s) => (items.length ? (s - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[sel];
      if (it) void it.run();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // keep focus trapped in the input
    }
  };

  let lastGroup = '';
  return (
    <div class="fixed inset-0 z-[60] flex justify-center items-start pt-[14vh] px-4 bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && (paletteOpen.value = false)}>
      <div class="hud-panel w-full max-w-[600px] shadow-[0_24px_64px_rgb(0_0_0/0.55)]" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="flex items-center gap-2.5 px-3.5 border-b border-line">
          <Search size={15} strokeWidth={1.5} class="text-fg-3 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            class="flex-1 min-w-0 bg-transparent py-3.5 text-[14px] text-fg placeholder:text-fg-3 outline-none"
            placeholder="Search pages and actions, or ask Monarch…"
            value={q}
            onInput={(e) => {
              setQ((e.target as HTMLInputElement).value);
              setSel(0);
            }}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[sel] ? `pal-${items[sel].id}` : undefined}
            autocomplete="off"
            spellcheck={false}
          />
          <kbd class="kbd kbd-xs bg-transparent border-line text-fg-3 font-mono">Esc</kbd>
        </div>
        <div ref={listRef} id="palette-list" role="listbox" class="max-h-[min(420px,56vh)] overflow-y-auto py-1.5">
          {items.length === 0 && <div class="px-4 py-6 text-center font-mono text-[10px] tracking-[0.16em] uppercase text-fg-3">No matches</div>}
          {items.map((it, i) => {
            const Icon = it.icon;
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            const active = i === sel;
            return (
              <div key={it.id}>
                {header && <div class="px-4 pt-2 pb-1 hud-label text-[9.5px]">{header}</div>}
                <div
                  id={`pal-${it.id}`}
                  data-idx={i}
                  role="option"
                  aria-selected={active}
                  class={`mx-1.5 flex items-center gap-3 px-2.5 py-2 cursor-pointer border-l-2 ${active ? 'bg-subtle border-red' : 'border-transparent hover:bg-white/[0.02]'}`}
                  onMouseMove={() => sel !== i && setSel(i)}
                  onClick={() => void it.run()}
                >
                  <Icon size={14} strokeWidth={1.5} class={active ? 'text-fg' : 'text-fg-3'} />
                  {it.group === 'Ask' ? (
                    <span class="flex-1 min-w-0 truncate text-[13px]">
                      <span class="text-fg-2">Ask Monarch: </span>
                      <span class="text-fg">{it.label}</span>
                    </span>
                  ) : (
                    <span class={`flex-1 min-w-0 truncate text-[13px] ${active ? 'text-fg' : 'text-fg-2'}`}>{it.label}</span>
                  )}
                  {it.hint && it.group !== 'Ask' && <span class="font-mono text-[9.5px] tracking-[0.14em] uppercase text-fg-3">{it.hint}</span>}
                  {active && <CornerDownLeft size={12} strokeWidth={1.5} class="text-fg-3" />}
                </div>
              </div>
            );
          })}
        </div>
        <div class="flex items-center gap-4 px-3.5 py-2 border-t border-line font-mono text-[9.5px] tracking-[0.14em] uppercase text-fg-3">
          <span>↑↓ select</span>
          <span>↵ run</span>
          <span class="ml-auto">{conn.value === 'open' ? 'Core linked' : 'Core offline'}</span>
        </div>
      </div>
    </div>
  );
}
