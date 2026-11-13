/**
 * HUD-style chat log: a narrow gutter (speaker + time) and a content column. Auto-scrolls while pinned to the bottom;
 * shows "jump to latest" when the user scrolled up.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChatItem } from '@monarch/shared';
import { ArrowDown, ChevronRight, AlertTriangle, Copy } from 'lucide-preact';
import { settings } from '../../lib/store.ts';
import { fmt } from '../ui.tsx';
import { Markdown, copyText } from './markdown.tsx';
import { ToolCard, toolFamily } from './tool-card.tsx';

type Assistant = Extract<ChatItem, { kind: 'assistant' }>;

function Gutter(props: { who: string; ts: string; tone?: 'user' | 'agent' | 'sys' | 'err'; live?: boolean }) {
  const color = props.tone === 'user' ? 'text-fg-2' : props.tone === 'err' ? 'text-red' : props.tone === 'sys' ? 'text-fg-3' : 'text-fg';
  return (
    <div class="w-[84px] shrink-0 pt-[3px] select-none">
      <div class={`font-mono text-[10px] tracking-[0.14em] uppercase truncate flex items-center gap-1.5 ${color}`}>
        {props.tone === 'agent' && <span class={`inline-block w-1.5 h-1.5 ${props.live ? 'bg-red hud-blink' : 'bg-fg-3'}`} />}
        {props.who}
      </div>
      <div class="font-mono text-[10px] text-fg-3 tabular-nums mt-0.5">{props.ts ? fmt.time(props.ts) : ''}</div>
    </div>
  );
}

function Row(props: { children: ComponentChildren; class?: string; group?: boolean }) {
  return <div class={`group flex gap-3 px-4 ${props.class ?? ''}`}>{props.children}</div>;
}

function Thinking(props: { text: string; live: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? props.live;
  const words = props.text.trim().split(/\s+/).length;
  return (
    <div class="mb-1.5">
      <button class="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] uppercase text-fg-3 hover:text-fg-2" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
        <ChevronRight size={11} strokeWidth={1.5} class={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        {props.live ? <span class="hud-blink">thinking</span> : 'thinking'}
        <span class="normal-case tracking-normal">· {words} words</span>
      </button>
      {isOpen && <div class="mt-1.5 pl-3 border-l border-line text-[12.5px] leading-relaxed text-fg-3 whitespace-pre-wrap max-h-72 overflow-auto">{props.text}</div>}
    </div>
  );
}

function AssistantBody(props: { item: Assistant; live: boolean }) {
  const { item } = props;
  const waiting = item.streaming && !item.text && !item.thinking;
  return (
    <div class="flex-1 min-w-0">
      {item.thinking && <Thinking text={item.thinking} live={!!item.streaming && !item.text} />}
      {waiting ? (
        <div class="h-5 flex items-center">
          <span class="inline-block w-[7px] h-[14px] bg-fg-2 hud-blink" />
        </div>
      ) : item.text ? (
        <Markdown text={item.text} caret={!!item.streaming} />
      ) : null}
      {!item.streaming && item.text && (
        <div class="h-4 flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
          <button class="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3 hover:text-fg-2" onClick={() => void copyText(item.text, 'Response copied')}>
            <Copy size={10} strokeWidth={1.5} /> copy
          </button>
          {item.model && <span class="font-mono text-[10px] text-fg-3">{item.model}</span>}
        </div>
      )}
    </div>
  );
}

/** group consecutive tool calls under the preceding assistant turn */
type Block =
  | { type: 'item'; item: ChatItem }
  | { type: 'tools'; items: Extract<ChatItem, { kind: 'tool' }>[]; id: string; ts: string };

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
  const agentName = (settings.value?.assistant.name || 'Monarch').toUpperCase();
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
  const lastAssistantStreaming = props.running;

  return (
    <div class={`relative flex-1 min-h-0 ${props.class ?? ''}`}>
      <div ref={scroller} onScroll={onScroll} class="absolute inset-0 overflow-y-auto overscroll-contain" role="log" aria-live="polite">
        {props.items.length === 0 ? (
          props.empty
        ) : (
          <div class="py-4 flex flex-col gap-4 max-w-[980px] mx-auto">
            {blocks.map((b) => {
              if (b.type === 'tools') {
                return (
                  <Row key={b.id}>
                    <div class="w-[84px] shrink-0 pt-2 select-none">
                      <div class="font-mono text-[10px] tracking-[0.14em] uppercase text-fg-3">
                        {b.items.length > 1 ? `TOOLS ×${b.items.length}` : 'TOOL'}
                      </div>
                    </div>
                    <div class="flex-1 min-w-0 flex flex-col gap-1">
                      {b.items.map((t) => (
                        <ToolCard
                          key={t.id}
                          item={t}
                          sessionId={props.sessionId}
                          defaultOpen={props.expandEdits && (toolFamily(t.name) === 'edit' || toolFamily(t.name) === 'write') && t.status !== 'error'}
                        />
                      ))}
                    </div>
                  </Row>
                );
              }
              const it = b.item;
              switch (it.kind) {
                case 'user':
                  return (
                    <Row key={it.id}>
                      <Gutter who="YOU" ts={it.ts} tone="user" />
                      <div class={`flex-1 min-w-0 border-l border-fg-3/60 bg-subtle/40 px-3 py-2 text-[14px] leading-relaxed text-fg whitespace-pre-wrap break-words ${it.id.startsWith('local-') ? 'opacity-70' : ''}`}>
                        {it.text}
                      </div>
                    </Row>
                  );
                case 'assistant':
                  return (
                    <Row key={it.id}>
                      <Gutter who={agentName} ts={it.ts} tone="agent" live={!!it.streaming && !!lastAssistantStreaming} />
                      <AssistantBody item={it} live={!!it.streaming} />
                    </Row>
                  );
                case 'error':
                  return (
                    <Row key={it.id}>
                      <Gutter who="ERROR" ts={it.ts} tone="err" />
                      <div class="flex-1 min-w-0 flex items-start gap-2 border border-red/40 bg-red/[0.06] px-3 py-2 text-[13px] text-fg">
                        <AlertTriangle size={14} strokeWidth={1.5} class="text-red shrink-0 mt-0.5" />
                        <span class="break-words whitespace-pre-wrap font-mono text-[12px]">{it.message}</span>
                      </div>
                    </Row>
                  );
                case 'system':
                  return (
                    <Row key={it.id}>
                      <Gutter who="SYS" ts={it.ts} tone="sys" />
                      <div class="flex-1 min-w-0 font-mono text-[11.5px] text-fg-3 pt-[3px] whitespace-pre-wrap break-words">{it.text}</div>
                    </Row>
                  );
              }
            })}
            {props.running && lastItem && lastItem.kind !== 'assistant' && (
              <Row>
                <Gutter who={agentName} ts="" tone="agent" live />
                <div class="flex-1 h-5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-fg-3">
                  <span class="inline-block w-[7px] h-[14px] bg-fg-2 hud-blink" />
                  {lastItem.kind === 'tool' && lastItem.status === 'pending-approval' ? 'awaiting approval' : 'working'}
                </div>
              </Row>
            )}
            {props.footer}
          </div>
        )}
      </div>
      {showJump && props.items.length > 0 && (
        <button
          class="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 border border-line bg-surface px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-fg-2 hover:text-fg hover:border-fg-3 shadow-[0_4px_16px_rgb(0_0_0/0.4)]"
          onClick={() => toBottom(true)}
        >
          <ArrowDown size={11} strokeWidth={1.5} /> jump to latest
          {props.running && <span class="inline-block w-1.5 h-1.5 bg-red hud-blink" />}
        </button>
      )}
    </div>
  );
}
