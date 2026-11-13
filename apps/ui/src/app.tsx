/**
 * App shell: top bar (brand, nav, engine badge, clock), routed page area, footer status line, global overlays.
 * OWNED BY THE ORCHESTRATOR. Pages live in ./pages/*.tsx and each default-exports a component.
 */
import type { ComponentType } from 'preact';
import type { LucideIcon } from 'lucide-preact';
import {
  LayoutGrid,
  MessageSquare,
  Wrench,
  Mail,
  Hash,
  CalendarDays,
  Network,
  Activity,
  SlidersHorizontal,
  Bell,
} from 'lucide-preact';
import { route, conn, health, phase, metrics, settings, toasts, unreadNotifications, navigate } from './lib/store.ts';
import { useNow, fmt, Dot } from './components/ui.tsx';
import OverviewPage from './pages/overview.tsx';
import CommsPage from './pages/comms.tsx';
import WorkshopPage from './pages/workshop.tsx';
import MailPage from './pages/mail.tsx';
import SlackPage from './pages/slack.tsx';
import AgendaPage from './pages/agenda.tsx';
import MemoryPage from './pages/memory.tsx';
import SystemsPage from './pages/systems.tsx';
import ConfigPage from './pages/config.tsx';
import { ApprovalDock, focusApprovals } from './components/approvals.tsx';
import { CommandPalette } from './components/command-palette.tsx';
import { NotificationDrawer, notificationsOpen } from './components/notifications.tsx';

// the core orb dispatches this when the user clicks it while an approval is pending
window.addEventListener('monarch:focus-approvals', () => focusApprovals());

const NAV: { id: string; label: string; icon: LucideIcon; page: ComponentType<{ params: string[] }> }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid, page: OverviewPage },
  { id: 'comms', label: 'Comms', icon: MessageSquare, page: CommsPage },
  { id: 'workshop', label: 'Workshop', icon: Wrench, page: WorkshopPage },
  { id: 'mail', label: 'Mail', icon: Mail, page: MailPage },
  { id: 'slack', label: 'Slack', icon: Hash, page: SlackPage },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays, page: AgendaPage },
  { id: 'memory', label: 'Memory', icon: Network, page: MemoryPage },
  { id: 'systems', label: 'Systems', icon: Activity, page: SystemsPage },
  { id: 'config', label: 'Config', icon: SlidersHorizontal, page: ConfigPage },
];

export function App() {
  const [current, ...params] = route.value;
  const entry = NAV.find((n) => n.id === current) ?? NAV[0];
  const Page = entry.page;
  return (
    <div class="h-full flex flex-col">
      <TopBar active={entry.id} />
      <main class="flex-1 min-h-0 relative">
        <Page params={params} />
      </main>
      <Footer section={entry.label} index={NAV.indexOf(entry)} />
      <ApprovalDock />
      <CommandPalette />
      <NotificationDrawer />
      <Toasts />
    </div>
  );
}

function TopBar(props: { active: string }) {
  const now = useNow();
  const h = health.value;
  const s = settings.value;
  const engineLabel = s ? (s.engine === 'claude-sdk' ? `CLAUDE · ${s.claudeSdk.model}` : `PI · ${s.pi.provider}/${s.pi.model}`) : h ? h.model : '—';
  return (
    <header class="h-14 shrink-0 flex items-stretch border-b border-line bg-[#121213]/90 backdrop-blur-sm" data-tauri-drag-region>
      <div class="flex flex-col justify-center px-5 min-w-[200px]" data-tauri-drag-region>
        <div class="font-mono text-[13px] tracking-[0.28em] text-fg flex items-center gap-2">
          <span class="inline-block w-2 h-2 bg-red" />
          MONARCH
        </div>
        <div class="font-mono text-[10px] tracking-[0.12em] text-fg-3 mt-0.5 uppercase">
          {conn.value === 'open' ? `NODE.${(h?.version ?? '').replace(/\./g, '')} / ${phase.value}` : conn.value === 'connecting' ? 'LINKING CORE…' : 'CORE OFFLINE'}
        </div>
      </div>
      <nav class="flex items-stretch overflow-x-auto overflow-y-hidden min-w-0 [scrollbar-width:none]">
        {NAV.map((n) => {
          const Icon = n.icon;
          return (
            <a key={n.id} href={`#/${n.id}`} class="hud-nav" title={n.label} aria-current={props.active === n.id ? 'page' : undefined}>
              <Icon size={13} strokeWidth={1.5} />
              <span class="hidden 2xl:inline">{n.label}</span>
            </a>
          );
        })}
      </nav>
      <div class="ml-auto flex items-center gap-4 pr-5 pl-4" data-tauri-drag-region>
        <button
          class="hidden lg:flex items-center gap-2 font-mono text-[10px] tracking-widest uppercase text-fg-2 border border-line px-2 py-1 hover:border-fg-3"
          onClick={() => navigate('config')}
          title="Model engine"
        >
          <Dot tone={conn.value === 'open' ? (phase.value === 'idle' ? 'ok' : 'red') : 'warn'} pulse={phase.value !== 'idle'} />
          <span class="max-w-[220px] truncate">{engineLabel}</span>
        </button>
        <button class="relative text-fg-2 hover:text-fg" onClick={() => (notificationsOpen.value = !notificationsOpen.value)} title="Notifications">
          <Bell size={16} strokeWidth={1.5} />
          {unreadNotifications.value > 0 && <span class="absolute -top-1 -right-1.5 min-w-3.5 h-3.5 px-0.5 bg-red text-[9px] font-mono leading-3.5 text-center text-fg">{unreadNotifications.value}</span>}
        </button>
        <div class="text-right" data-tauri-drag-region>
          <div class="font-mono text-lg leading-none tabular-nums text-fg">{fmt.timeSec(now)}</div>
          <div class="font-mono text-[10px] tracking-[0.12em] text-fg-3 mt-1 uppercase">
            {now.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
          </div>
        </div>
      </div>
    </header>
  );
}

function Footer(props: { section: string; index: number }) {
  const m = metrics.value;
  const loc = settings.value?.user.location;
  return (
    <footer class="h-7 shrink-0 border-t border-line flex items-center px-5 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 gap-4">
      <span>
        SEC.{String(props.index).padStart(2, '0')} / {props.section}
      </span>
      {m && <span>UPTIME {fmt.uptime(m.uptimeSec)}</span>}
      {m && <span>CPU {fmt.pct(m.cpu.load)}</span>}
      {m && <span>MEM {fmt.pct(m.mem.percent)}</span>}
      <span class="ml-auto">
        <kbd class="kbd kbd-xs bg-transparent border-line text-fg-3">Ctrl</kbd> <kbd class="kbd kbd-xs bg-transparent border-line text-fg-3">K</kbd> COMMAND
      </span>
      {loc && (
        <span>
          {loc.lat.toFixed(4)} N / {loc.lon.toFixed(4)} {loc.lon < 0 ? 'W' : 'E'}
        </span>
      )}
    </footer>
  );
}

function Toasts() {
  if (!toasts.value.length) return null;
  return (
    <div class="toast toast-end toast-bottom z-50 mb-8">
      {toasts.value.map((t) => (
        <div
          key={t.id}
          class={`border bg-surface px-3 py-2 text-xs max-w-sm font-mono ${
            t.level === 'error' ? 'border-red text-fg' : t.level === 'warn' ? 'border-warning text-fg' : t.level === 'success' ? 'border-success text-fg' : 'border-line text-fg-2'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
