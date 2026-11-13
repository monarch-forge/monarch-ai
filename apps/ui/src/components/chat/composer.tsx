/**
 * Message composer: autosizing textarea, Enter to send / Shift+Enter newline, Stop while running,
 * ↑ in an empty box recalls the last message, optional slash commands.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { CornerDownLeft, Square } from 'lucide-preact';
import { conn } from '../../lib/store.ts';

export interface SlashCommand {
  cmd: string; // "/new"
  description: string;
  run: (arg: string) => void;
}

const HISTORY_KEY = 'monarch.composer.history';
function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function pushHistory(text: string) {
  try {
    const h = loadHistory().filter((x) => x !== text);
    h.push(text);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-50)));
  } catch {
    /* ignore */
  }
}

/** imperative focus hook: pages call `focusComposer()` (e.g. after "new chat") */
const focusers = new Set<() => void>();
export function focusComposer(): void {
  focusers.forEach((f) => f());
}

export function Composer(props: {
  onSend: (text: string) => void | Promise<unknown>;
  onAbort?: () => void;
  running?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** left side of the status strip, e.g. engine/model indicator */
  meta?: ComponentChildren;
  /** right side controls (engine selector, etc.) */
  tools?: ComponentChildren;
  commands?: SlashCommand[];
  autoFocus?: boolean;
  /** external text injection (quick prompts): set value + focus */
  inject?: { text: string; n: number } | null;
}) {
  const [text, setText] = useState('');
  const [sel, setSel] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const histIdx = useRef<number | null>(null);
  const offline = conn.value !== 'open';
  const disabled = props.disabled || offline;

  useEffect(() => {
    const f = () => ta.current?.focus();
    focusers.add(f);
    if (props.autoFocus) f();
    return () => void focusers.delete(f);
  }, []);

  useEffect(() => {
    if (props.inject) {
      setText(props.inject.text);
      requestAnimationFrame(() => {
        const el = ta.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  }, [props.inject?.n]);

  const autosize = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  };
  useLayoutEffect(autosize, [text, offline, props.placeholder]);
  // re-measure when the width changes (layout settles after mount, window resizes)
  useEffect(() => {
    const el = ta.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        autosize();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const slash = text.startsWith('/') && !text.includes('\n') && props.commands?.length ? props.commands.filter((c) => c.cmd.startsWith(text.split(' ')[0])) : [];

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    const [head, ...rest] = value.split(' ');
    const cmd = props.commands?.find((c) => c.cmd === head);
    if (cmd) {
      setText('');
      cmd.run(rest.join(' '));
      return;
    }
    if (disabled || props.running) return;
    pushHistory(value);
    histIdx.current = null;
    setText('');
    void props.onSend(value);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (slash.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + slash.length) % slash.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        setText(slash[Math.min(sel, slash.length - 1)].cmd + ' ');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (slash.length && !props.commands?.some((c) => c.cmd === text.trim().split(' ')[0])) {
        const c = slash[Math.min(sel, slash.length - 1)];
        setText('');
        c.run('');
        return;
      }
      submit();
      return;
    }
    if (e.key === 'Escape' && props.running && props.onAbort) {
      e.preventDefault();
      props.onAbort();
      return;
    }
    // history recall
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (!text || histIdx.current !== null)) {
      const h = loadHistory();
      if (!h.length) return;
      const el = ta.current!;
      if (e.key === 'ArrowUp' && el.selectionStart !== 0 && text) return;
      e.preventDefault();
      let i = histIdx.current ?? h.length;
      i = e.key === 'ArrowUp' ? Math.max(0, i - 1) : i + 1;
      if (i >= h.length) {
        histIdx.current = null;
        setText('');
      } else {
        histIdx.current = i;
        setText(h[i]);
      }
    }
  };

  return (
    <div class="border-t border-line bg-surface">
      {slash.length > 0 && (
        <div class="border-b border-line">
          {slash.map((c, i) => (
            <button
              key={c.cmd}
              class={`w-full flex items-center gap-3 px-4 py-1.5 text-left ${i === sel ? 'bg-subtle' : 'hover:bg-white/[0.02]'}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setText('');
                c.run('');
              }}
            >
              <span class="font-mono text-[12px] text-fg w-20">{c.cmd}</span>
              <span class="text-[12px] text-fg-3">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <div class="flex items-end gap-2 px-3 pt-3">
        <span class="font-mono text-[13px] text-red pb-[9px] pl-1 select-none">›</span>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onInput={(e) => {
            setText((e.target as HTMLTextAreaElement).value);
            setSel(0);
          }}
          onKeyDown={onKey}
          placeholder={offline ? 'Core offline — reconnecting…' : (props.placeholder ?? 'Message Monarch…')}
          disabled={offline}
          class="flex-1 resize-none bg-transparent outline-none text-[14px] leading-[1.55] text-fg placeholder:text-fg-3 py-1.5 max-h-[260px] min-h-[34px] disabled:opacity-60"
          aria-label="Message"
        />
        {props.running ? (
          <button
            class="btn btn-sm btn-outline border-red/60 text-fg hover:bg-red hover:border-red rounded-[2px] font-mono font-normal uppercase tracking-wider text-[11px] mb-0.5"
            onClick={() => props.onAbort?.()}
            title="Stop (Esc)"
          >
            <Square size={10} fill="currentColor" /> Stop
          </button>
        ) : (
          <button
            class="btn btn-sm btn-primary rounded-[2px] font-mono font-normal uppercase tracking-wider text-[11px] mb-0.5"
            onClick={submit}
            disabled={disabled || !text.trim()}
            title="Send (Enter)"
          >
            Send <CornerDownLeft size={11} />
          </button>
        )}
      </div>
      <div class="flex items-center gap-3 px-4 pb-2 pt-1.5 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 min-h-7">
        <div class="flex items-center gap-3 min-w-0 truncate">{props.meta}</div>
        <div class="ml-auto flex items-center gap-3 shrink-0">
          {props.tools}
          <span class="hidden md:inline">
            <kbd class="kbd kbd-xs bg-transparent border-line text-fg-3">↵</kbd> send <kbd class="kbd kbd-xs bg-transparent border-line text-fg-3 ml-1">⇧↵</kbd> newline
            {props.commands?.length ? (
              <>
                {' '}
                <kbd class="kbd kbd-xs bg-transparent border-line text-fg-3 ml-1">/</kbd> commands
              </>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}
