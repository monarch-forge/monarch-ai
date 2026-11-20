/**
 * "Ask Monarch" — global Ctrl+Space floating prompt. Reuses the Home console's rolling quick session
 * (console-store) so replies stream into a floating card without leaving the current page.
 */
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Copy, CornerDownLeft, MessageSquare, Sparkles, X } from 'lucide-preact';
import { conn, navigate, toast } from '../../lib/store.ts';
import { Markdown } from '../chat/markdown.tsx';
import { consoleRun, runConsoleCommand } from '../overview/console-store.ts';

export const askOpen = signal(false);

const STATUS: Record<string, string> = { sending: 'Sending…', thinking: 'Thinking…', tool: 'Working…', streaming: 'Answering…', done: 'Done', error: 'Failed' };

export function AskBar() {
  const [text, setText] = useState('');
  // only show a reply this bar started (the console run may belong to Home)
  const [ref, setRef] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const open = askOpen.value;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        askOpen.value = !askOpen.value;
      } else if (e.key === 'Escape' && askOpen.value) {
        e.preventDefault();
        askOpen.value = false;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open) window.setTimeout(() => input.current?.focus(), 20);
  }, [open]);

  if (!open) return null;
  const run = consoleRun.value && consoleRun.value.ref === ref ? consoleRun.value : null;
  const busy = !!run && run.status !== 'done' && run.status !== 'error';

  const submit = (e: Event) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || conn.value !== 'open') return;
    runConsoleCommand(t);
    setRef(consoleRun.value?.ref ?? null);
    setText('');
  };

  return (
    <div class="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[14vh] bg-black/40 backdrop-blur-[2px] animate-monarch-fade" onClick={() => (askOpen.value = false)}>
      <div
        class="w-full max-w-xl flex flex-col gap-2"
        role="dialog"
        aria-label="Ask Monarch"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={submit} class="flex items-center gap-3 h-14 px-4 rounded-[20px] bg-black border border-[#2c2c30]">
          <Sparkles size={18} strokeWidth={1.5} class="text-fg-3 shrink-0" />
          <input
            ref={input}
            value={text}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
            placeholder={conn.value === 'open' ? 'Ask Monarch…' : 'Monarch core is offline'}
            class="flex-1 min-w-0 bg-transparent outline-none text-[15px] text-fg placeholder:text-fg-3"
            aria-label="Ask Monarch"
          />
          <span class="hidden sm:flex items-center gap-1 text-[11px] text-fg-3">
            <CornerDownLeft size={12} strokeWidth={1.6} /> send · Esc close
          </span>
        </form>
        {run && (
          <div class="rounded-[20px] bg-black border border-[#2c2c30] overflow-hidden">
            <div class="flex items-center gap-2 px-4 h-10 border-b border-line text-[12px] text-fg-3">
              <span class={busy ? 'hud-blink' : ''}>{STATUS[run.status] ?? run.status}</span>
              <span class="truncate">· {run.prompt}</span>
              <div class="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  class="h-7 px-2 rounded-[9px] flex items-center gap-1.5 hover:bg-raised hover:text-fg transition-colors disabled:opacity-40"
                  disabled={!run.sessionId}
                  onClick={() => {
                    askOpen.value = false;
                    navigate(`chat/${encodeURIComponent(run.sessionId!)}`);
                  }}
                >
                  <MessageSquare size={13} strokeWidth={1.6} /> Open in Chat
                </button>
                <button
                  type="button"
                  class="w-7 h-7 rounded-[9px] flex items-center justify-center hover:bg-raised hover:text-fg transition-colors disabled:opacity-40"
                  disabled={!run.reply}
                  title="Copy"
                  aria-label="Copy reply"
                  onClick={() => navigator.clipboard.writeText(run.reply).then(() => toast('Copied', 'success'), () => toast('Copy failed', 'error'))}
                >
                  <Copy size={13} strokeWidth={1.6} />
                </button>
                <button type="button" class="w-7 h-7 rounded-[9px] flex items-center justify-center hover:bg-raised hover:text-fg transition-colors" title="Close (Esc)" aria-label="Close" onClick={() => (askOpen.value = false)}>
                  <X size={14} strokeWidth={1.6} />
                </button>
              </div>
            </div>
            <div class="px-4 py-3 max-h-[50vh] overflow-y-auto text-[14px]" aria-live="polite">
              {run.status === 'error' ? (
                <p class="text-red">{run.error ?? 'Something went wrong.'}</p>
              ) : run.reply ? (
                <Markdown text={run.reply} caret={run.status === 'streaming'} />
              ) : (
                <p class="text-fg-3">{run.tool ? `Using ${run.tool}…` : 'Thinking…'}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
