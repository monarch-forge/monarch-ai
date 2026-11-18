/**
 * App shell: slim top bar (brand, 6 labeled sections + More menu, Auto, search, bell, clock), routed page area, global overlays.
 * The old footer status line is gone; an offline banner appears only when the core is unreachable.
 * OWNED BY THE ORCHESTRATOR. Pages live in ./pages/*.tsx and each default-exports a component.
 */
import type { ComponentType } from 'preact';
import type { LucideIcon } from 'lucide-preact';
import {
  Zap,
  Wallet,
  LayoutGrid,
  MessageSquare,
  Wrench,
  Mail,
  Hash,
  CalendarDays,
  Network,
  Activity,
  Route as RouteIcon,
  Dna,
  SlidersHorizontal,
  Bell,
  Search,
  MessageCircle,
  Inbox,
  ChevronDown,
} from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { route, conn, health, phase, settings, toasts, toast, unreadNotifications } from './lib/store.ts';
import { useNow, fmt } from './components/ui.tsx';
import { api } from './lib/api.ts';
import type { Settings } from '@monarch/shared';
import OverviewPage from './pages/overview.tsx';
import CommsPage from './pages/comms.tsx';
import WorkshopPage from './pages/workshop.tsx';
import MailPage from './pages/mail.tsx';
import SlackPage from './pages/slack.tsx';
import WhatsAppPage from './pages/whatsapp.tsx';
import AgendaPage from './pages/agenda.tsx';
import MemoryPage from './pages/memory.tsx';
import SystemsPage from './pages/systems.tsx';
import RouterPage from './pages/router.tsx';
import EvolvePage from './pages/evolve.tsx';
import ConfigPage from './pages/config.tsx';
import LedgerPage from './pages/ledger.tsx';
import WelcomePage from './pages/welcome.tsx';
import { ApprovalDock, focusApprovals } from './components/approvals.tsx';
import { CommandPalette, paletteOpen } from './components/command-palette.tsx';
import { NotificationDrawer, notificationsOpen } from './components/notifications.tsx';

// the core orb dispatches this when the user clicks it while an approval is pending
window.addEventListener('monarch:focus-approvals', () => focusApprovals());

interface Route {
  id: string;
  label: string;
  icon: LucideIcon;
  page: ComponentType<{ params: string[] }>;
}

/** every routable page; the top bar shows PRIMARY + an Inbox entry + the MORE menu */
const ROUTES: Route[] = [
  { id: 'overview', label: 'Home', icon: LayoutGrid, page: OverviewPage },
  { id: 'chat', label: 'Chat', icon: MessageSquare, page: CommsPage },
  { id: 'mail', label: 'Mail', icon: Mail, page: MailPage },
  { id: 'slack', label: 'Slack', icon: Hash, page: SlackPage },
  { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle, page: WhatsAppPage },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays, page: AgendaPage },
  { id: 'ledger', label: 'Ledger', icon: Wallet, page: LedgerPage },
  { id: 'workshop', label: 'Workshop', icon: Wrench, page: WorkshopPage },
  { id: 'memory', label: 'Memory', icon: Network, page: MemoryPage },
  { id: 'evolve', label: 'Evolve', icon: Dna, page: EvolvePage },
  { id: 'systems', label: 'Systems', icon: Activity, page: SystemsPage },
  { id: 'router', label: '9Router', icon: RouteIcon, page: RouterPage },
  { id: 'config', label: 'Settings', icon: SlidersHorizontal, page: ConfigPage },
];
const INBOX = ['mail', 'slack', 'whatsapp'];
const PRIMARY = ['overview', 'chat', 'inbox', 'agenda', 'ledger', 'workshop'];
const MORE = ['memory', 'evolve', 'systems', 'router', 'config'];
const byId = (id: string) => ROUTES.find((r) => r.id === id)!;

/** the Inbox tab last opened (the nav entry returns to it) */
function lastInbox(): string {
  try {
    const t = localStorage.getItem('monarch.inbox');
    return t && INBOX.includes(t) ? t : 'mail';
  } catch {
    return 'mail';
  }
}

export function App() {
  let [current, ...params] = route.value;
  // legacy aliases: "#/comms/..." and "#/beru/..." (old notifications, stored links, tool output) -> canonical "#/chat/..."
  if (current === 'comms' || current === 'beru') {
    current = 'chat';
    location.replace('#/' + ['chat', ...params].map(encodeURIComponent).join('/'));
  }
  useEffect(() => {
    // first launch: show the guides once
    try {
      if (!localStorage.getItem('monarch.welcomed')) {
        localStorage.setItem('monarch.welcomed', '1');
        if (!location.hash || location.hash === '#/' || location.hash === '#/overview') location.replace('#/welcome');
      }
    } catch {
      /* storage unavailable */
    }
  }, []);
  const hidden = current === 'welcome';
  const entry = ROUTES.find((n) => n.id === current) ?? ROUTES[0];
  const Page = hidden ? WelcomePage : entry.page;
  const inInbox = INBOX.includes(entry.id);
  useEffect(() => {
    if (!inInbox) return;
    try {
      localStorage.setItem('monarch.inbox', entry.id);
    } catch {
      /* ignore */
    }
  }, [entry.id]);
  return (
    <div class="h-full flex flex-col">
      <TopBar active={hidden ? current : inInbox ? 'inbox' : entry.id} />
      {inInbox && <InboxTabs active={entry.id} />}
      <main class="flex-1 min-h-0 relative animate-monarch-fade" key={hidden ? current : entry.id}>
        <Page params={params} />
      </main>
      <OfflineBanner />
      <ApprovalDock />
      <CommandPalette />
      <NotificationDrawer />
      <Toasts />
    </div>
  );
}

function TopBar(props: { active: string }) {
  const now = useNow(15_000);
  const unread = unreadNotifications.value;
  return (
    <header class="relative z-40 h-12 shrink-0 flex items-center gap-2 px-3 sm:px-4 bg-[#121213]/85 backdrop-blur-md" data-tauri-drag-region>
      <a href="#/overview" class="flex items-center gap-2 pr-2 sm:pr-3 shrink-0 text-fg" title={statusTitle()}>
        <span class={`inline-block w-2 h-2 rounded-full ${conn.value === 'open' ? 'bg-red' : 'bg-fg-3'} ${phase.value !== 'idle' && conn.value === 'open' ? 'hud-blink' : ''}`} />
        <span class="hidden sm:inline text-[14px] font-semibold tracking-[-0.01em]">Monarch</span>
      </a>
      <nav class="flex items-center gap-0.5 overflow-x-auto overflow-y-hidden min-w-0 [scrollbar-width:none]" aria-label="Sections">
        {PRIMARY.map((id) => {
          const r = id === 'inbox' ? { id, label: 'Inbox', icon: Inbox } : byId(id);
          const Icon = r.icon;
          const on = props.active === id;
          return (
            <a key={id} href={`#/${id === 'inbox' ? lastInbox() : id}`} class="hud-nav shrink-0" aria-current={on ? 'page' : undefined}>
              <Icon size={15} strokeWidth={1.6} class="sm:hidden" />
              <span class="hidden sm:inline">{r.label}</span>
            </a>
          );
        })}
        <MoreMenu active={props.active} />
      </nav>
      <div class="ml-auto flex items-center gap-1 sm:gap-2 shrink-0" data-tauri-drag-region>
        <AutoSwitch />
        <button
          type="button"
          class="hidden md:flex items-center gap-1.5 h-7 px-2 rounded-md text-[12px] text-fg-3 hover:text-fg hover:bg-raised transition-colors"
          onClick={() => (paletteOpen.value = true)}
          title="Search and commands"
        >
          <Search size={14} strokeWidth={1.6} />
          <span class="hidden lg:inline">Ctrl K</span>
        </button>
        <button
          type="button"
          class="relative w-8 h-8 flex items-center justify-center rounded-md text-fg-2 hover:text-fg hover:bg-raised transition-colors"
          onClick={() => (notificationsOpen.value = !notificationsOpen.value)}
          title="Notifications"
          aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
        >
          <Bell size={16} strokeWidth={1.6} />
          {unread > 0 && <span class="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-red text-[10px] font-medium leading-4 text-center text-fg">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <div
          class="hidden sm:block pl-1 text-[13px] tabular-nums text-fg-2"
          title={now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          data-tauri-drag-region
        >
          {fmt.time(now)}
        </div>
      </div>
    </header>
  );
}

/** the "More" menu: everything outside the daily pages */
function MoreMenu(props: { active: string }) {
  const [open, setOpen] = useState(false);
  const on = MORE.includes(props.active);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const t = setTimeout(() => window.addEventListener('click', close, { once: true }));
    return () => {
      clearTimeout(t);
      window.removeEventListener('click', close);
    };
  }, [open]);
  return (
    <div class="relative shrink-0">
      <button type="button" class="hud-nav" aria-haspopup="menu" aria-expanded={open} aria-current={on ? 'page' : undefined} onClick={() => setOpen(!open)}>
        <span class="hidden sm:inline">{on ? byId(props.active).label : 'More'}</span>
        <ChevronDown size={13} strokeWidth={1.8} />
      </button>
      {open && (
        <div role="menu" class="fixed mt-1 min-w-[180px] rounded-lg border border-line bg-[#1c1c1e] p-1 shadow-xl animate-monarch-fade">
          {MORE.map((id) => {
            const r = byId(id);
            const Icon = r.icon;
            return (
              <a key={id} role="menuitem" href={`#/${id}`} class={`flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[13px] ${props.active === id ? 'bg-raised text-fg' : 'text-fg-2 hover:bg-raised hover:text-fg'}`}>
                <Icon size={14} strokeWidth={1.6} /> {r.label}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Mail / Slack / WhatsApp as tabs of one Inbox (each keeps its own route and deep links) */
function InboxTabs(props: { active: string }) {
  return (
    <div class="shrink-0 flex items-center gap-1 px-3 sm:px-4 h-9 border-b border-line">
      {INBOX.map((id) => {
        const r = byId(id);
        const Icon = r.icon;
        const on = props.active === id;
        return (
          <a key={id} href={`#/${id}`} class={`flex items-center gap-1.5 px-2.5 h-7 rounded-md text-[12.5px] transition-colors ${on ? 'bg-raised text-fg' : 'text-fg-3 hover:text-fg-2'}`} aria-current={on ? 'page' : undefined}>
            <Icon size={13} strokeWidth={1.7} /> {r.label}
          </a>
        );
      })}
    </div>
  );
}

function statusTitle(): string {
  const h = health.value;
  if (conn.value === 'connecting') return 'Connecting to the core…';
  if (conn.value !== 'open') return 'The core is offline';
  return `Monarch ${h?.version ?? ''} · ${phase.value === 'idle' ? 'ready' : phase.value.replace('-', ' ')}`;
}

/** calm banner instead of the old footer: only visible while the core is unreachable */
function OfflineBanner() {
  const [show, setShow] = useState(false);
  const c = conn.value;
  // avoid flashing during the first connect / short reconnects
  useEffect(() => {
    if (c === 'open') {
      setShow(false);
      return;
    }
    const t = window.setTimeout(() => setShow(true), 2500);
    return () => window.clearTimeout(t);
  }, [c]);
  if (!show || c === 'open') return null;
  return (
    <div class="fixed left-1/2 -translate-x-1/2 bottom-4 z-30 flex items-center gap-2 px-3.5 py-2 rounded-full bg-surface shadow-[0_12px_32px_rgb(0_0_0/0.45)] text-[12.5px] text-fg-2 animate-monarch-fade" role="status">
      <span class={`inline-block w-1.5 h-1.5 rounded-full ${c === 'connecting' ? 'bg-fg-3 hud-blink' : 'bg-warning'}`} />
      {c === 'connecting' ? 'Reconnecting to Monarch…' : 'Monarch is offline — things will catch up once it is back.'}
    </div>
  );
}

/** top-right engine/model badge: a dropdown that sets the default engine + model for new sessions */
/** Auto mode: the agent works hands-off and only pings you when it needs you (Config → Permissions has the details) */
function AutoSwitch() {
  const s = settings.value;
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const on = s.permissions.mode === 'auto';
  const toggle = async () => {
    setBusy(true);
    try {
      settings.value = await api.put<Settings>('/settings', { permissions: { mode: on ? 'ask' : 'auto' } });
      toast(on ? 'Auto mode off: Monarch asks before sensitive actions' : 'Auto mode on: Monarch works on its own and notifies you when it needs you', 'success');
    } catch (e: any) {
      toast(`Could not switch: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void toggle()}
      title={on ? 'Auto mode on: hands-off, only send/post/delete need approval. Click to turn off.' : 'Turn on Auto mode: Monarch works on its own and notifies you only when it needs you.'}
      class={`flex items-center gap-1.5 h-7 px-2 rounded-md text-[12px] transition-colors ${on ? 'text-fg bg-raised' : 'text-fg-3 hover:text-fg hover:bg-raised'}`}
    >
      <Zap size={13} strokeWidth={1.75} class={on ? 'text-red' : ''} />
      <span class="hidden sm:inline">Auto</span>
    </button>
  );
}


function Toasts() {
  if (!toasts.value.length) return null;
  return (
    <div class="toast toast-end toast-bottom z-50 p-4 gap-2">
      {toasts.value.map((t) => (
        <div key={t.id} class="flex items-start gap-2.5 bg-surface rounded-[10px] px-3.5 py-2.5 text-[13px] text-fg max-w-sm shadow-[0_12px_32px_rgb(0_0_0/0.45)] animate-monarch-fade">
          <span
            class={`mt-[7px] inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
              t.level === 'error' ? 'bg-red' : t.level === 'warn' ? 'bg-warning' : t.level === 'success' ? 'bg-success' : 'bg-fg-3'
            }`}
          />
          <span class="whitespace-normal leading-snug">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
