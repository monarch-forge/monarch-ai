/**
 * Calm chat log: user messages as soft bubbles on the right, replies as plain reading text, each tool group as one quiet summary line. Auto-scrolls while pinned to the bottom;
 * shows "jump to latest" when the user scrolled up.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChatItem } from '@monarch/shared';
import { ArrowDown, ChevronRight, AlertTriangle, Copy } from 'lucide-preact';
import { settings } from '../../lib/store.ts';
import { fmt, Glyph, useNow } from '../ui.tsx';
import { Markdown, copyText } from './markdown.tsx';
import { ToolCard, toolFamily, toolHeadline } from './tool-card.tsx';

type Assistant = Extract<ChatItem, { kind: 'assistant' }>;

function Thinking(props: { text: string; live: boolean; ts?: string; endTs?: string }) {
  const [pinned, setPinned] = useState(false);
  const [peek, setPeek] = useState(false);
  const isOpen = pinned || peek;
  const now = useNow(props.live ? 1000 : 3_600_000);
  const end = props.live ? now.getTime() : props.endTs ? Date.parse(props.endTs) : NaN;
  const secs = props.ts ? Math.round((end - Date.parse(props.ts)) / 1000) : NaN;
  const dur = Number.isFinite(secs) && secs >= 0 ? `${secs}s` : '';
  return (
    <div class="mb-2" onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)}>
      <button class="flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg-2 transition-colors" onClick={() => setPinned(!pinned)} aria-expanded={isOpen}>
        {props.live ? <span class="hud-blink">Thinking{dur ? ` · ${dur}` : '…'}</span> : dur ? `Thought for ${dur}` : 'Thought'}
        <ChevronRight size={12} strokeWidth={1.75} class={`transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`} />
      </button>
      {isOpen && (
        <div class="mt-1.5 ml-1 pl-3 border-l-2 border-[var(--bg-subtle)] text-[13px] leading-relaxed text-fg-3 whitespace-pre-wrap max-h-72 overflow-auto">{props.text}</div>
      )}
    </div>
  );
}

function Dots() {
  return (
    <span class="inline-flex items-center gap-1" aria-hidden="true">
      <span class="w-1.5 h-1.5 rounded-full bg-fg-3 hud-blink" />
      <span class="w-1.5 h-1.5 rounded-full bg-fg-3 hud-blink [animation-delay:.2s]" />
      <span class="w-1.5 h-1.5 rounded-full bg-fg-3 hud-blink [animation-delay:.4s]" />
    </span>
  );
}

function AssistantBody(props: { item: Assistant; endTs?: string }) {
  const { item } = props;
  const waiting = item.streaming && !item.text && !item.thinking;
  return (
    <div class="group min-w-0">
      {item.thinking && <Thinking text={item.thinking} live={!!item.streaming && !item.text} ts={item.ts} endTs={props.endTs} />}
      {waiting ? (
        <div class="h-6 flex items-center">
          <Dots />
        </div>
      ) : item.text ? (
        <Markdown text={item.text} caret={!!item.streaming} class="text-[14.5px] leading-[1.65]" />
      ) : null}
      {!item.streaming && item.text && (
        <div class="h-6 mt-1 flex items-center gap-3 text-[11.5px] text-fg-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
          <button class="flex items-center gap-1 hover:text-fg-2" onClick={() => void copyText(item.text, 'Response copied')}>
            <Copy size={12} strokeWidth={1.75} /> Copy
          </button>
          {item.ts && <span class="tabular-nums">{fmt.time(item.ts)}</span>}
          {item.model && <span class="font-mono text-[10.5px]">{item.model}</span>}
        </div>
      )}
    </div>
  );
}

/** group consecutive tool calls under the preceding assistant turn */
type Block =
  | { type: 'item'; item: ChatItem }
  | { type: 'tools'; items: Extract<ChatItem, { kind: 'tool' }>[]; id: string; ts: string };

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** "Ran, read, gmail search" — distinct verbs of a tool group (max 3), or "Used N tools" */
export function toolGroupSummary(items: ToolItem[]): string {
  const verbs: string[] = [];
  for (const t of items) {
    const v = toolHeadline(t.name, t.input, 'ok').verb.toLowerCase();
    if (v && !verbs.includes(v)) verbs.push(v);
  }
  if (!verbs.length || verbs.length > 3) return `Used ${items.length} tool${items.length === 1 ? '' : 's'}`;
  const txt = verbs.join(', ');
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

/** one quiet line per tool group; errors, denials, approvals (and edits when asked) always stay visible as cards */
function ToolGroup(props: { items: ToolItem[]; sessionId?: string | null; expandEdits?: boolean }) {
  const [open, setOpen] = useState(false);
  const isEdit = (t: ToolItem) => toolFamily(t.name) === 'edit' || toolFamily(t.name) === 'write';
  const sticky = (t: ToolItem) => t.status === 'error' || t.status === 'denied' || t.status === 'pending-approval' || (!!props.expandEdits && isEdit(t));
  const running = props.items.some((t) => t.status === 'running');
  const n = props.items.length;
  const card = (t: ToolItem) => (
    <ToolCard key={t.id} item={t} sessionId={props.sessionId} defaultOpen={props.expandEdits && isEdit(t) && t.status !== 'error'} />
  );
  return (
    <div class="flex flex-col gap-0.5 -my-2">
      <button
        class="self-start flex items-center gap-2 rounded-[var(--radius-control)] px-1.5 -mx-1.5 py-1 text-[12px] text-fg-3 hover:text-fg-2 hover:bg-white/[0.03] transition-colors duration-150"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {running ? <Glyph value={3} of={5} live /> : <span aria-hidden="true">·</span>}
        <span class="truncate">{toolGroupSummary(props.items)}</span>
        <span aria-hidden="true">·</span>
        <span class="tabular-nums shrink-0">
          {n} tool{n === 1 ? '' : 's'}
        </span>
        <ChevronRight size={12} strokeWidth={1.75} class={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
      </button>
      {open ? props.items.map(card) : props.items.filter(sticky).map(card)}
    </div>
  );
}

function toBlocks(items: ChatItem[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    if (it.kind === 'tool') {
      const last = out[out.length - 1];
      if (last && last.type === 'tools') last.items.push(it);
      else out.push({ type: 'tools', items: [it], id: it.id, ts: it.ts });
    } else out.push({ type: 'item', item: it });
  }
  return out;
}

function blockTs(b: Block | undefined): string | undefined {
  return b ? (b.type === 'tools' ? b.ts : b.item.ts) : undefined;
}

export function Transcript(props: {
  items: ChatItem[];
  sessionId?: string | null;
  running?: boolean;
  /** shown when there are no items */
  empty?: ComponentChildren;
  /** auto-expand edit/write tool cards (Workshop) */
  expandEdits?: boolean;
  /** extra content rendered after the last item (e.g. turn stats) */
  footer?: ComponentChildren;
  class?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const agentName = settings.value?.assistant.name || 'Monarch';
  const lastItem = props.items[props.items.length - 1];

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinned.current = atBottom;
    setShowJump(!atBottom);
  };

  const toBottom = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    pinned.current = true;
    setShowJump(false);
  };

  // new session → jump to bottom
  useEffect(() => {
    pinned.current = true;
    requestAnimationFrame(() => toBottom());
  }, [props.sessionId]);

  // content changed → follow if pinned
  useLayoutEffect(() => {
    if (pinned.current) toBottom();
  }, [props.items, props.running]);

  // the user just sent something → always follow
  useEffect(() => {
    if (lastItem?.kind === 'user') toBottom();
  }, [lastItem?.id]);

  const blocks = toBlocks(props.items);

  return (
    <div class={`relative flex-1 min-h-0 ${props.class ?? ''}`}>
      <div ref={scroller} onScroll={onScroll} class="absolute inset-0 overflow-y-auto overscroll-contain" role="log" aria-live="polite">
        {props.items.length === 0 ? (
          props.empty
        ) : (
          <div class="px-4 md:px-6 pt-2 pb-8 flex flex-col gap-6 max-w-[760px] mx-auto">
            {blocks.map((b, bi) => {
              if (b.type === 'tools') return <ToolGroup key={b.id} items={b.items} sessionId={props.sessionId} expandEdits={props.expandEdits} />;
              const it = b.item;
              switch (it.kind) {
                case 'user':
                  return (
                    <div key={it.id} class="flex justify-end">
                      <div
                        class={`max-w-[85%] rounded-[16px] rounded-br-[6px] bg-[var(--bg-raised,#202023)] px-4 py-2.5 text-[14.5px] leading-[1.6] text-fg whitespace-pre-wrap break-words ${
                          it.id.startsWith('local-') ? 'opacity-70' : ''
                        }`}
                        title={it.ts ? fmt.time(it.ts) : undefined}
                      >
                        {it.text}
                      </div>
                    </div>
                  );
                case 'assistant':
                  return <AssistantBody key={it.id} item={it} endTs={blockTs(blocks[bi + 1])} />;
                case 'error':
                  return (
                    <div key={it.id} class="flex items-start gap-2.5 rounded-[10px] bg-red/[0.07] px-4 py-3 text-[13px] text-fg-2">
                      <AlertTriangle size={15} strokeWidth={1.75} class="text-red shrink-0 mt-0.5" />
                      <span class="break-words whitespace-pre-wrap min-w-0">{it.message}</span>
                    </div>
                  );
                case 'system':
                  return (
                    <div key={it.id} class="-my-2 truncate text-center text-[11.5px] text-fg-3" title={it.text}>
                      {it.text.replace(/\s+/g, ' ')}
                    </div>
                  );
              }
            })}
            {props.running && lastItem && lastItem.kind !== 'assistant' && (
              <div key="working-row" class="h-6 flex items-center gap-2.5 text-[12.5px] text-fg-3">
                <Dots />
                {lastItem.kind === 'tool' && lastItem.status === 'pending-approval' ? `${agentName} is waiting for your approval` : `${agentName} is working…`}
              </div>
            )}
            {props.footer}
          </div>
        )}
      </div>
      {showJump && props.items.length > 0 && (
        <button
          class="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-[var(--bg-raised,#202023)] px-3.5 py-1.5 text-[12px] text-fg-2 hover:text-fg shadow-[0_12px_32px_rgb(0_0_0/.45)] transition-colors duration-150"
          onClick={() => toBottom(true)}
        >
          <ArrowDown size={13} strokeWidth={1.75} /> Latest
          {props.running && <span class="w-1.5 h-1.5 rounded-full bg-red hud-blink" />}
        </button>
      )}
    </div>
  );
}
