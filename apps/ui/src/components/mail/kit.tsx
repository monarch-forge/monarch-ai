/**
 * Small shared kit for the UI-C pages (mail / slack / agenda / memory):
 * modal + confirm dialog, account colour markers, "ask Monarch" helper, state blocks, date helpers.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import { socket } from '../../lib/api.ts';
import { conn, navigate } from '../../lib/store.ts';
import { Btn, Spinner } from '../ui.tsx';

/* ─────────── ask Monarch ─────────── */

/** hand a prompt to the agent in a fresh chat session and jump to Comms */
export function askMonarch(text: string): void {
  socket.send({ type: 'chat.send', text });
  navigate('comms');
}

/* ─────────── account colour markers (calm, never red — red means attention) ─────────── */

const ACCOUNT_TONES = ['#8FA3B8', '#5FAE7F', '#D9A441', '#B49AC8', '#6FB3B0', '#C8C8CC', '#C79A7A', '#7F8FD1'];

export function accountColor(id: string | undefined | null): string {
  if (!id) return '#9E9EA4';
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ACCOUNT_TONES[Math.abs(h) % ACCOUNT_TONES.length];
}

export function AccountMark(props: { id?: string | null; size?: number; title?: string; class?: string }) {
  const s = props.size ?? 6;
  return (
    <span
      class={`inline-block shrink-0 ${props.class ?? ''}`}
      style={{ width: `${s}px`, height: `${s}px`, background: accountColor(props.id) }}
      title={props.title}
      aria-hidden={props.title ? undefined : 'true'}
    />
  );
}

/* ─────────── button (Btn with `disabled` typed — Btn's props type lacks it) ─────────── */

export function Button(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'outline'; size?: 'xs' | 'sm' | 'md'; loading?: boolean },
) {
  return <Btn {...(props as any)} />;
}

/* ─────────── modal ─────────── */

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  code?: string;
  title: string;
  width?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // only the top-most modal reacts
      const all = document.querySelectorAll('[aria-modal="true"]');
      if (all[all.length - 1] !== boxRef.current) return;
      e.stopPropagation();
      props.onClose();
    };
    window.addEventListener('keydown', onKey, true);
    // focus first field
    const t = window.setTimeout(() => {
      const box = boxRef.current;
      const el =
        box?.querySelector<HTMLElement>('[data-autofocus]') ??
        box?.querySelector<HTMLElement>('.hud-body input:not([type=checkbox]):not([type=hidden]), .hud-body textarea, .hud-body select') ??
        box?.querySelector<HTMLElement>('footer button:last-child');
      el?.focus();
    }, 20);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.clearTimeout(t);
      prev?.focus?.();
    };
  }, [props.open]);
  if (!props.open) return null;
  return (
    <div
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div ref={boxRef} role="dialog" aria-modal="true" aria-label={props.title} class={`hud-panel w-full max-h-[90vh] ${props.width ?? 'max-w-lg'}`}>
        <header class="hud-head">
          {props.code && <span class="hud-code">{props.code}</span>}
          <h2 class="hud-title">{props.title}</h2>
          <button class="ml-auto text-fg-3 hover:text-fg" onClick={props.onClose} title="Close (Esc)" aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div class="hud-body overflow-y-auto">{props.children}</div>
        {props.footer && <footer class="flex items-center gap-2 justify-end px-3.5 py-2.5 border-t border-line">{props.footer}</footer>}
      </div>
    </div>
  );
}

/** promise-based confirm dialog: const [dialog, confirm] = useConfirm(); if (await confirm({...})) … */
export function useConfirm(): [ComponentChildren, (o: { title: string; body?: ComponentChildren; confirmLabel?: string; danger?: boolean }) => Promise<boolean>] {
  const [state, setState] = useState<null | { title: string; body?: ComponentChildren; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void }>(null);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const el = (
    <Modal
      open={!!state}
      onClose={() => close(false)}
      code="CNF"
      title={state?.title ?? ''}
      width="max-w-md"
      footer={
        <>
          <Btn variant="ghost" onClick={() => close(false)}>
            Cancel
          </Btn>
          <Btn variant="primary" data-autofocus onClick={() => close(true)}>
            {state?.confirmLabel ?? 'Confirm'}
          </Btn>
        </>
      }
    >
      <div class="text-sm text-fg-2 leading-relaxed">{state?.body}</div>
    </Modal>
  );
  const ask = (o: { title: string; body?: ComponentChildren; confirmLabel?: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => setState({ ...o, resolve }));
  return [el, ask];
}

/* ─────────── state blocks ─────────── */

/** centered status block for empty / error / offline / loading states */
export function StateBlock(props: { icon?: ComponentChildren; title: string; children?: ComponentChildren; class?: string }) {
  return (
    <div class={`flex flex-col items-center justify-center text-center gap-3 px-6 py-10 ${props.class ?? ''}`}>
      {props.icon && <div class="text-fg-3">{props.icon}</div>}
      <div class="hud-label text-fg-2">{props.title}</div>
      {props.children && <div class="text-xs text-fg-3 max-w-sm leading-relaxed">{props.children}</div>}
    </div>
  );
}

/** inline loading line */
export function Loading(props: { label?: string; class?: string }) {
  return (
    <div class={`flex items-center gap-2 hud-label px-3 py-4 ${props.class ?? ''}`}>
      <Spinner /> {props.label ?? 'Loading'}
    </div>
  );
}

/** error block that knows about the core being offline */
export function LoadError(props: { error?: string; onRetry?: () => void; class?: string }) {
  if (!props.error) return null;
  const offline = conn.value !== 'open' || /offline/i.test(props.error);
  return (
    <StateBlock class={props.class} title={offline ? 'Core offline' : 'Request failed'}>
      <div>{offline ? 'The Monarch core is unreachable. Retrying automatically when the link is back.' : props.error}</div>
      {props.onRetry && (
        <div class="mt-3">
          <Btn size="xs" onClick={props.onRetry}>
            Retry
          </Btn>
        </div>
      )}
    </StateBlock>
  );
}

/* ─────────── keyboard helpers ─────────── */

/** true when the event originates in a text field (ignore single-key shortcuts then) */
export function isTypingTarget(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/** global single-key shortcuts while no modal/input is focused */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps: unknown[] = []): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, deps);
}

/* ─────────── date helpers ─────────── */

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO -> value for <input type="datetime-local"> */
export function toLocalInput(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> ISO (or null when empty/invalid) */
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** relative label for future or past instants: "in 3h", "2d ago", "now" */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const s = Math.round((t - Date.now()) / 1000);
  const a = Math.abs(s);
  const v = a < 60 ? 'now' : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  if (v === 'now') return 'now';
  return s > 0 ? `in ${v}` : `${v} ago`;
}

/** mail-list style time: today -> 14:05, this year -> "Nov 3", else "2024-11-03" */
export function shortStamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  if (sameDay(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (now.getTime() - d.getTime() < 6 * 86400000 && d.getTime() < now.getTime()) return d.toLocaleDateString([], { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return toDateInput(d);
}

/** extract the display name from an RFC 5322 "Name <addr>" header */
export function displayName(from: string | undefined): string {
  if (!from) return '';
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return m[1].trim() || m[2];
  return from.trim();
}

/** extract bare addresses from an address list header */
export function addresses(list: string | undefined): string[] {
  if (!list) return [];
  const out: string[] = [];
  for (const part of list.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = part.match(/<([^>]+)>/);
    const a = (m ? m[1] : part).trim();
    if (a && a.includes('@')) out.push(a);
  }
  return out;
}
