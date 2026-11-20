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
      <div class="fixed inset-0 top-12 z-40 bg-black/25" onClick={() => (notificationsOpen.value = false)} aria-hidden="true" />
      <aside
        ref={panelRef}
        class="hud-panel !bg-black !border !border-[#2c2c30] !rounded-[20px] fixed right-3 top-[72px] bottom-3 z-40 w-[min(400px,calc(100vw-24px))]"
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
      >
        <header class="hud-head">
          <h2 class="hud-title">Notifications</h2>
          <div class="ml-auto flex items-center gap-2">
            {unread > 0 && <Tag>{`${unread} new`}</Tag>}
            <button type="button" class="text-fg-3 hover:text-fg p-0.5" onClick={() => (notificationsOpen.value = false)} aria-label="Close notifications" data-autofocus>
              <X size={15} strokeWidth={1.5} />
            </button>
          </div>
        </header>
        <div class="flex items-center justify-between px-[18px] pb-2">
          <span class="text-[12px] text-fg-3">{list.length ? `${list.length} in total` : conn.value === 'open' ? '' : 'Monarch is offline'}</span>
          <button
            type="button"
            class="flex items-center gap-1.5 text-[12px] text-fg-2 hover:text-fg disabled:text-fg-3 disabled:cursor-default"
            onClick={markAll}
            disabled={busy || !unread || conn.value !== 'open'}
          >
            {busy && <Spinner />}
            Mark all read
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          {list.length === 0 ? (
            <div class="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
              <span class="text-[13px] text-fg-2">{conn.value === 'open' ? "You're all caught up" : 'Monarch is offline'}</span>
              <span class="text-[12px] text-fg-3">Reminders, automation results and alerts land here.</span>
            </div>
          ) : (
            <ul>
              {list.map((n) => {
                const inner = (
                  <>
                    <div class="flex items-center gap-2">
                      {n.level !== 'info' && <Tag tone={levelTone(n.level)}>{n.level === 'warn' ? 'Heads up' : n.level === 'error' ? 'Problem' : 'Done'}</Tag>}
                      <span class="ml-auto text-[11px] text-fg-3 tabular-nums" title={fmt.dateTime(n.ts)}>
                        {fmt.ago(n.ts) === 'now' ? 'now' : fmt.ago(n.ts)} · {fmt.time(n.ts)}
                      </span>
                      {!n.read && <span class="inline-block w-1.5 h-1.5 rounded-full bg-red" aria-label="unread" />}
                    </div>
                    <div class={`mt-1 text-[13.5px] ${n.read ? 'text-fg-2' : 'text-fg font-medium'}`}>{n.title}</div>
                    {n.body && <div class="mt-0.5 text-[12px] text-fg-3 leading-snug line-clamp-3 whitespace-pre-line">{n.body}</div>}
                    
                  </>
                );
                return (
                  <li key={n.id} class="rounded-[10px] hover:bg-raised transition-colors duration-150">
                    {n.href ? (
                      <button type="button" class="w-full text-left px-3 py-3 rounded-[10px] focus-visible:bg-raised outline-none" onClick={() => openItem(n)}>
                        {inner}
                      </button>
                    ) : (
                      <div class="px-3 py-3">{inner}</div>
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
