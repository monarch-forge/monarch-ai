/**
 * App shell: slim top bar (brand, nav, model, search, bell, clock), routed page area, global overlays.
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
} from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { route, conn, health, phase, settings, toasts, toast, unreadNotifications } from './lib/store.ts';
import { useNow, fmt, Dot } from './components/ui.tsx';
import { ModelPicker, defaultChoice, type ModelChoice } from './components/chat/model-picker.tsx';
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

const NAV: { id: string; label: string; icon: LucideIcon; page: ComponentType<{ params: string[] }> }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid, page: OverviewPage },
  { id: 'chat', label: 'Chat', icon: MessageSquare, page: CommsPage },
  { id: 'workshop', label: 'Workshop', icon: Wrench, page: WorkshopPage },
  { id: 'mail', label: 'Mail', icon: Mail, page: MailPage },
  { id: 'slack', label: 'Slack', icon: Hash, page: SlackPage },
  { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle, page: WhatsAppPage },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays, page: AgendaPage },
  { id: 'ledger', label: 'Ledger', icon: Wallet, page: LedgerPage },
  { id: 'memory', label: 'Memory', icon: Network, page: MemoryPage },
  { id: 'systems', label: 'Systems', icon: Activity, page: SystemsPage },
  { id: 'evolve', label: 'Evolve', icon: Dna, page: EvolvePage },
  { id: 'router', label: '9Router', icon: RouteIcon, page: RouterPage },
  { id: 'config', label: 'Config', icon: SlidersHorizontal, page: ConfigPage },
];

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
  const entry = NAV.find((n) => n.id === current) ?? NAV[0];
  const Page = hidden ? WelcomePage : entry.page;
  return (
    <div class="h-full flex flex-col">
      <TopBar active={hidden ? current : entry.id} />
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
        {NAV.map((n) => {
          const Icon = n.icon;
          const on = props.active === n.id;
          return (
            <a key={n.id} href={`#/${n.id}`} class="hud-nav tip shrink-0" data-tip={on ? undefined : n.label} aria-label={n.label} aria-current={on ? 'page' : undefined}>
              <Icon size={15} strokeWidth={1.6} />
              <span class={on ? 'hidden md:inline' : 'hidden min-[1680px]:inline'}>{n.label}</span>
            </a>
          );
        })}
      </nav>
      <div class="ml-auto flex items-center gap-1 sm:gap-2 shrink-0" data-tauri-drag-region>
        <AutoSwitch />
        <EngineSwitch />
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

function EngineSwitch() {
  const s = settings.value;
  const h = health.value;
  const dot = <Dot tone={conn.value === 'open' ? (phase.value === 'idle' ? 'ok' : 'red') : 'warn'} pulse={phase.value !== 'idle'} />;
  if (!s) {
    return (
      <span class="hidden lg:flex items-center gap-2 text-[12px] text-fg-3 px-2">
        {dot}
        <span class="max-w-[220px] truncate">{h ? h.model : '—'}</span>
      </span>
    );
  }
  const onChange = async (c: ModelChoice | null) => {
    if (!c) return;
    let patch: Record<string, unknown>;
    if (c.engine === 'claude-sdk') patch = { engine: 'claude-sdk', claudeSdk: { model: c.model } };
    else {
      const i = c.model.indexOf('/');
      patch = { engine: 'pi', pi: { provider: c.model.slice(0, i), model: c.model.slice(i + 1) } };
    }
    try {
      settings.value = await api.put<Settings>('/settings', patch);
      toast(`Default model: ${c.engine === 'claude-sdk' ? `Claude · ${c.model}` : `pi · ${c.model}`}`, 'success');
    } catch (e: any) {
      toast(`Could not switch model: ${e?.message ?? e}`, 'error');
    }
  };
  return (
    <ModelPicker
      class="hidden lg:block"
      value={defaultChoice()}
      onChange={(c) => void onChange(c)}
      noDefault
      placement="down"
      title="Default engine and model — click to switch"
      leading={dot}
      buttonClass="!max-w-[230px]"
      renderLabel={(info, c) => {
        if ((c?.engine ?? s.engine) === 'claude-sdk') return `Claude · ${s.claudeSdk.model}`;
        return `Pi · ${info?.name ?? s.pi.model}`;
      }}
    />
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
