/**
 * Approval dock (UI-B): fixed bottom-center stack of pending tool approvals. Not modal — the rest of the UI stays usable.
 * Keyboard (when a card is focused): A = allow once, S = always for this session, D = deny, ↑/↓ move between cards.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { ApprovalRequest } from '@monarch/shared';
import { ChevronDown, ChevronRight } from 'lucide-preact';
import { approvals, conn, navigate } from '../lib/store.ts';
import { socket } from '../lib/api.ts';
import { fmt } from './ui.tsx';

/* ───────────── helpers shared with tool cards ───────────── */

/** "mcp__monarch__gmail_send" → "gmail_send" */
export function displayToolName(name: string): string {
  return name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
}

function sameInput(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** find the pending approval that belongs to a tool card */
export function findApproval(sessionId: string | null | undefined, toolName: string, input: unknown, list: ApprovalRequest[] = approvals.value): ApprovalRequest | undefined {
  if (!sessionId) return undefined;
  const name = displayToolName(toolName);
  const candidates = list.filter((a) => a.sessionId === sessionId && displayToolName(a.tool) === name);
  return candidates.find((a) => sameInput(a.input, input)) ?? candidates[0];
}

export function respondApproval(id: string, allow: boolean, always = false): void {
  socket.send({ type: 'approval.respond', id, allow, ...(always ? { always: true } : {}) });
  // optimistic: the core confirms with approval.resolved
  approvals.value = approvals.value.filter((a) => a.id !== id);
}

/* ───────────── focus API ───────────── */

const flash = signal(0);

/** bring the dock to attention and focus the first pending approval */
export function focusApprovals(): void {
  flash.value++;
  const el = document.getElementById('approval-dock');
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  window.setTimeout(() => el?.querySelector<HTMLElement>('[data-approval-card]')?.focus(), 30);
}

/* ───────────── component ───────────── */

const MAX_VISIBLE = 3;

export function ApprovalDock() {
  const list = approvals.value;
  const [showAll, setShowAll] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const f = flash.value;

  useEffect(() => {
    if (!f) return;
    setFlashing(true);
    const t = window.setTimeout(() => setFlashing(false), 900);
    return () => window.clearTimeout(t);
  }, [f]);

  useEffect(() => {
    if (list.length <= MAX_VISIBLE) setShowAll(false);
  }, [list.length]);

  if (!list.length) return null;
  const visible = showAll ? list : list.slice(0, MAX_VISIBLE);
  const hidden = list.length - visible.length;

  return (
    <div
      id="approval-dock"
      role="region"
      aria-label="Pending approvals"
      class={`fixed left-1/2 -translate-x-1/2 bottom-[124px] z-40 w-[min(560px,calc(100vw-2rem))] flex flex-col gap-2 max-h-[60vh] overflow-y-auto ${flashing ? 'outline outline-1 outline-red/60 outline-offset-4 rounded-[14px]' : ''}`}
    >
      <div class="flex items-center gap-2 px-3 py-1.5 bg-surface/95 backdrop-blur rounded-full text-[12px] text-fg-2 shadow-[0_12px_32px_rgb(0_0_0/0.45)]">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-red hud-blink" />
        <span>
          {list.length === 1 ? 'One thing needs your OK' : `${list.length} things need your OK`}
        </span>
        {conn.value !== 'open' && <span class="text-warning">· Monarch is offline</span>}
        <span class="ml-auto hidden sm:inline text-[11px] text-fg-3">
          <kbd class="kbd kbd-xs bg-transparent border-line text-fg-3">A</kbd> allow <kbd class="kbd kbd-xs bg-transparent border-line text-fg-3 ml-1">S</kbd> always{' '}
          <kbd class="kbd kbd-xs bg-transparent border-line text-fg-3 ml-1">D</kbd> deny
        </span>
      </div>
      {visible.map((a) => (
        <ApprovalCard key={a.id} req={a} />
      ))}
      {hidden > 0 && (
        <button class="self-center text-[12px] text-fg-2 hover:text-fg bg-surface rounded-full px-3 py-1" onClick={() => setShowAll(true)}>
          +{hidden} more
        </button>
      )}
    </div>
  );
}

function ApprovalCard(props: { req: ApprovalRequest }) {
  const a = props.req;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dangerous = a.risk === 'dangerous';

  const onKey = (e: KeyboardEvent) => {
    if (e.target !== ref.current || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'a') respondApproval(a.id, true);
    else if (k === 's') respondApproval(a.id, true, true);
    else if (k === 'd') respondApproval(a.id, false);
    else if (k === 'enter' || k === ' ') setOpen((o) => !o);
    else if (k === 'arrowdown' || k === 'arrowup') {
      const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-approval-card]'));
      const i = cards.indexOf(ref.current!);
      cards[(i + (k === 'arrowdown' ? 1 : -1) + cards.length) % cards.length]?.focus();
    } else return;
    e.preventDefault();
  };

  let inputJson = '';
  try {
    inputJson = JSON.stringify(a.input, null, 2) ?? '';
  } catch {
    inputJson = String(a.input);
  }

  return (
    <div
      ref={ref}
      tabIndex={0}
      data-approval-card
      onKeyDown={onKey}
      class={`hud-panel !rounded-[14px] shadow-[0_12px_32px_rgb(0_0_0/0.45)] outline-none border focus-visible:border-line ${dangerous ? 'border-red/40' : 'border-transparent'}`}
    >
      <div class="flex items-start gap-3 px-4 pt-3.5 pb-2">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="hud-tag" data-tone={dangerous ? 'red' : 'warn'}>
              {a.risk}
            </span>
            <span class="text-[13.5px] font-medium text-fg truncate">{displayToolName(a.tool)}</span>
            <span class="text-[11px] text-fg-3 ml-auto shrink-0 tabular-nums">{fmt.time(a.ts)}</span>
          </div>
          <div class="text-[13px] text-fg-2 mt-1.5 break-words">{a.summary || 'Tool call requires approval'}</div>
          <div class="flex items-center gap-3 mt-1.5">
            <button class="flex items-center gap-1 text-[12px] text-fg-3 hover:text-fg-2" onClick={() => setOpen(!open)}>
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Details
            </button>
            <button
              class="text-[12px] text-fg-3 hover:text-fg-2"
              onClick={() => navigate(`beru/${encodeURIComponent(a.sessionId)}`)}
              title="Open the session that requested this"
            >
              Open session ↗
            </button>
          </div>
          {open && <pre class="mt-2 max-h-56 overflow-auto bg-[#121213] rounded-md p-2.5 font-mono text-[11px] text-fg-2 whitespace-pre-wrap break-all">{inputJson}</pre>}
        </div>
      </div>
      <div class="flex items-center gap-1.5 px-4 pb-3.5 justify-end">
        <button class="btn btn-sm btn-ghost rounded-md font-medium text-[12.5px] text-fg-2 hover:text-fg" onClick={() => respondApproval(a.id, false)}>
          Deny
        </button>
        <button
          class="btn btn-sm btn-ghost rounded-md font-medium text-[12.5px] bg-raised text-fg-2 hover:bg-subtle hover:text-fg"
          onClick={() => respondApproval(a.id, true, true)}
          title="Allow this tool for the rest of this session"
        >
          Always this session
        </button>
        <button class="btn btn-sm btn-primary rounded-md font-medium text-[12.5px] border-transparent" onClick={() => respondApproval(a.id, true)}>
          Allow once
        </button>
      </div>
    </div>
  );
}
