/**
 * Message composer: autosizing textarea, Enter to send / Shift+Enter newline, Stop while running,
 * ↑ in an empty box recalls the last message, optional slash commands.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ArrowUp, Mic, Square } from 'lucide-preact';
import { conn, navigate, toast } from '../../lib/store.ts';
import { listen, listening, micLevel, stopListening, voiceSupport, UNSUPPORTED_LISTEN } from '../../lib/voice.ts';

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
  /** show a mic button; the transcript is sent through this (lets the page speak the reply) */
  onVoiceSend?: (text: string) => void | Promise<unknown>;
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
    <div class="shrink-0 px-3 md:px-6 pb-3 md:pb-4 pt-1">
      <div class="relative max-w-[760px] mx-auto">
        {slash.length > 0 && (
          <div class="absolute bottom-full left-0 right-0 mb-2 z-30 rounded-[var(--radius-card)] bg-[var(--bg-surface)] p-1.5 shadow-[0_12px_32px_rgb(0_0_0/.45)]">
            {slash.map((c, i) => (
              <button
                key={c.cmd}
                class={`w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-control)] text-left ${i === sel ? 'bg-[var(--bg-raised,#202023)]' : 'hover:bg-[var(--bg-raised,#202023)]'}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText('');
                  c.run('');
                }}
              >
                <span class="font-mono text-[12.5px] text-fg w-20">{c.cmd}</span>
                <span class="text-[12.5px] text-fg-3 truncate">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        <div class="flex items-end gap-1.5 rounded-[var(--radius-modal)] bg-[var(--bg-surface)] border border-[var(--border-default)] focus-within:border-fg-3/60 transition-colors duration-150 pl-4 pr-2 py-2.5">
          <textarea
            ref={ta}
            rows={1}
            value={text}
            onInput={(e) => {
              setText((e.target as HTMLTextAreaElement).value);
              setSel(0);
            }}
            onKeyDown={onKey}
            placeholder={offline ? 'Reconnecting to Monarch…' : listening.value && props.onVoiceSend ? 'Listening… tap the square when you’re done' : (props.placeholder ?? 'Message Monarch…')}
            disabled={offline}
            class="flex-1 resize-none bg-transparent outline-none text-[14.5px] leading-[1.55] text-fg placeholder:text-fg-3 py-1.5 max-h-[260px] min-h-[34px] disabled:opacity-60"
            aria-label="Message"
          />
          {props.onVoiceSend && <MicButton disabled={disabled || !!props.running} onText={(t) => void props.onVoiceSend!(t)} />}
          {props.running ? (
            <button
              class="w-9 h-9 shrink-0 rounded-full flex items-center justify-center bg-[var(--bg-subtle)] text-fg hover:bg-[var(--bg-raised,#202023)] transition-colors duration-150"
              onClick={() => props.onAbort?.()}
              title="Stop (Esc)"
              aria-label="Stop"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              class="w-9 h-9 shrink-0 rounded-full flex items-center justify-center bg-red text-fg hover:bg-red-hover disabled:bg-[var(--bg-subtle)] disabled:text-fg-3 transition-colors duration-150"
              onClick={submit}
              disabled={disabled || !text.trim()}
              title="Send (Enter)"
              aria-label="Send"
            >
              <ArrowUp size={17} strokeWidth={2} />
            </button>
          )}
        </div>
        <div class="flex items-center gap-3 px-1 pt-2 text-[11.5px] text-fg-3 min-h-7">
          <div class="flex items-center gap-3 min-w-0">{props.tools}</div>
          <div class="flex items-center gap-3 min-w-0 truncate">{props.meta}</div>
          {props.commands?.length ? (
            <span class="ml-auto hidden md:inline shrink-0">
              Type <span class="font-mono text-fg-2">/</span> for commands
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** push-to-talk: records one utterance through the cloud voice service and hands back the transcript */
function MicButton(props: { disabled?: boolean; onText: (text: string) => void }) {
  const on = listening.value;
  const ready = voiceSupport.listen;
  const click = async () => {
    if (!ready) {
      toast(voiceSupport.sttReady ? 'Voice input is off — turn it on in Config → Voice' : UNSUPPORTED_LISTEN, 'warn');
      navigate('config/voice');
      return;
    }
    if (on) {
      stopListening();
      return;
    }
    try {
      const heard = await listen();
      props.onText(heard);
    } catch (e: any) {
      toast(e?.message ?? 'Voice input failed', 'warn');
    }
  };
  return (
    <button
      type="button"
      class={`relative w-9 h-9 shrink-0 rounded-full flex items-center justify-center overflow-hidden transition-colors duration-150 ${
        on ? 'bg-red/15 text-red' : ready ? 'text-fg-3 hover:text-fg hover:bg-[var(--bg-raised,#202023)]' : 'text-fg-3/60 hover:text-fg-2 hover:bg-[var(--bg-raised,#202023)]'
      }`}
      onClick={() => void click()}
      disabled={props.disabled && !on}
      title={on ? 'Stop listening' : ready ? 'Speak your message' : UNSUPPORTED_LISTEN}
      aria-label={on ? 'Stop listening' : 'Voice input'}
    >
      {on ? <Square size={11} fill="currentColor" /> : <Mic size={17} strokeWidth={1.75} />}
      {on && (
        <span class="absolute inset-0 rounded-full border-2 border-red transition-opacity duration-100" style={{ opacity: Math.max(0.15, Math.min(1, micLevel.value * 1.6)) }} />
      )}
    </button>
  );
}
