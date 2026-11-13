/**
 * Notifications drawer — right-side panel toggled by `notificationsOpen` (top-bar bell, palette).
 * OWNED BY UI-A. Must keep exporting `notificationsOpen` and `NotificationDrawer`.
 */
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import type { Notification } from '@monarch/shared';
import { api } from '../lib/api.ts';
import { conn, navigate, notifications, toast, unreadNotifications } from '../lib/store.ts';
import { Spinner, Tag, fmt } from './ui.tsx';

export const notificationsOpen = signal(false);

const levelTone = (l: Notification['level']) => (l === 'error' ? 'red' : l === 'warn' ? 'warn' : l === 'success' ? 'ok' : 'default');

export function NotificationDrawer() {
  const open = notificationsOpen.value;
  const panelRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const list = notifications.value.slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const unread = unreadNotifications.value;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        notificationsOpen.value = false;
      }
    };
    window.addEventListener('keydown', onKey);
    window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus(), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const markAll = async () => {
    setBusy(true);
    try {
      await api.post('/notifications/read');
      notifications.value = notifications.value.map((n) => ({ ...n, read: true }));
    } catch (e: any) {
      toast(e?.message ?? 'Could not mark notifications read', 'error');
    } finally {
      setBusy(false);
    }
  };

  const openItem = (n: Notification) => {
    if (!n.href) return;
    notificationsOpen.value = false;
    navigate(n.href);
  };

  return (
    <>
      <div class="fixed inset-0 top-14 bottom-7 z-40 bg-black/30" onClick={() => (notificationsOpen.value = false)} aria-hidden="true" />
      <aside
        ref={panelRef}
        class="hud-panel fixed right-3 top-[60px] bottom-[32px] z-40 w-[min(400px,calc(100vw-24px))] shadow-[0_12px_40px_rgb(0_0_0/0.5)]"
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
      >
        <header class="hud-head">
          <span class="hud-code">NTF.00</span>
          <h2 class="hud-title">Notifications</h2>
          <div class="ml-auto flex items-center gap-2">
            {unread > 0 && <Tag tone="red">{`${unread} unread`}</Tag>}
            <button type="button" class="text-fg-3 hover:text-fg p-0.5" onClick={() => (notificationsOpen.value = false)} aria-label="Close notifications" data-autofocus>
              <X size={15} strokeWidth={1.5} />
            </button>
          </div>
        </header>
        <div class="flex items-center justify-between px-3.5 py-2 border-b border-line">
          <span class="hud-label text-[10px]">{list.length ? `${list.length} total` : conn.value === 'open' ? 'Feed' : 'Core offline'}</span>
          <button
            type="button"
            class="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] uppercase text-fg-2 hover:text-fg disabled:text-fg-3 disabled:cursor-default"
            onClick={markAll}
            disabled={busy || !unread || conn.value !== 'open'}
          >
            {busy && <Spinner />}
            Mark all read
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto">
          {list.length === 0 ? (
            <div class="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
              <span class="inline-block w-1.5 h-1.5 border border-fg-3" />
              <span class="font-mono text-[10px] tracking-[0.16em] uppercase text-fg-3">{conn.value === 'open' ? 'No notifications' : 'Core offline'}</span>
              <span class="text-[11px] text-fg-3">Reminders, automation results and alerts land here.</span>
            </div>
          ) : (
            <ul>
              {list.map((n) => {
                const inner = (
                  <>
                    <div class="flex items-center gap-2">
                      <Tag tone={levelTone(n.level)}>{n.level}</Tag>
                      <span class="ml-auto font-mono text-[10px] text-fg-3 tabular-nums" title={fmt.dateTime(n.ts)}>
                        {fmt.ago(n.ts) === 'now' ? 'now' : fmt.ago(n.ts)} · {fmt.time(n.ts)}
                      </span>
                      {!n.read && <span class="inline-block w-1.5 h-1.5 bg-red" aria-label="unread" />}
                    </div>
                    <div class={`mt-1.5 text-[13px] ${n.read ? 'text-fg-2' : 'text-fg'}`}>{n.title}</div>
                    {n.body && <div class="mt-0.5 text-[12px] text-fg-3 leading-snug line-clamp-3 whitespace-pre-line">{n.body}</div>}
                    {n.href && <div class="mt-1 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3">Open →</div>}
                  </>
                );
                return (
                  <li key={n.id} class={`border-b border-line/60 border-l-2 ${n.read ? 'border-l-transparent' : 'border-l-red'}`}>
                    {n.href ? (
                      <button type="button" class="w-full text-left px-3.5 py-2.5 hover:bg-white/[0.02] focus-visible:bg-white/[0.03] outline-none" onClick={() => openItem(n)}>
                        {inner}
                      </button>
                    ) : (
                      <div class="px-3.5 py-2.5">{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
