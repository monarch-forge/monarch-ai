/** Overview command console: input + mic + send, quick actions, and a live reply preview. OWNED BY UI-A. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowRight, CornerDownLeft, Mic, Plus, Square, X } from 'lucide-preact';
import { conn, navigate, settings, toast } from '../../lib/store.ts';
import { interimTranscript, listen, listening, stopListening, voiceSupport, UNSUPPORTED_LISTEN } from '../../lib/voice.ts';
import { Markdown } from '../chat/markdown.tsx';
import { Tag } from '../ui.tsx';
import { activeConversation, consoleConversation, consoleHistory, consoleRun, dismissConsoleRun, newConsoleConversation, runConsoleCommand } from './console-store.ts';

const QUICK = [
  { label: 'Brief me', prompt: 'Brief me on today' },
  { label: 'Triage inbox', prompt: 'Triage my inbox' },
  { label: "What's blocked", prompt: "What's blocked or waiting on me?" },
];

export function CommandConsole() {
  const [text, setText] = useState('');
  const histIdx = useRef<number>(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const honorific = settings.value?.user.honorific?.trim() || 'sir';
  const run = consoleRun.value;
  const isListening = listening.value;
  // read the signal so the component re-renders when the conversation starts/ends
  const conv = consoleConversation.value ? activeConversation() : null;

  const submit = (t: string) => {
    const v = t.trim();
    if (!v) return;
    if (conn.value !== 'open') toast('Core offline — command queued until the link is restored', 'warn');
    runConsoleCommand(v);
    setText('');
    histIdx.current = -1;
  };

  const onMic = async () => {
    if (!voiceSupport.listen) {
      toast(voiceSupport.sttReady ? 'Voice input is off — turn it on in Config → Voice' : UNSUPPORTED_LISTEN, 'warn');
      navigate('config/voice');
      return;
    }
    if (isListening) {
      stopListening();
      return;
    }
    try {
      const heard = await listen();
      setText(heard);
      submit(heard);
    } catch (e: any) {
      const msg = e?.message ?? 'Voice input failed';
      if (msg !== 'Listening cancelled') toast(msg, 'warn');
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const hist = consoleHistory.value;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(text);
    } else if (e.key === 'Escape') {
      if (text) setText('');
      else inputRef.current?.blur();
    } else if (e.key === 'ArrowUp' && hist.length && (!text || histIdx.current >= 0)) {
      e.preventDefault();
      histIdx.current = histIdx.current < 0 ? hist.length - 1 : Math.max(0, histIdx.current - 1);
      setText(hist[histIdx.current] ?? '');
    } else if (e.key === 'ArrowDown' && histIdx.current >= 0) {
      e.preventDefault();
      histIdx.current = histIdx.current + 1;
      if (histIdx.current >= hist.length) {
        histIdx.current = -1;
        setText('');
      } else setText(hist[histIdx.current] ?? '');
    }
  };

  const shown = isListening ? interimTranscript.value : text;

  return (
    <div class="flex flex-col gap-[26px] w-full">
      <div class={`flex items-center gap-3 h-[60px] pl-[22px] pr-2 rounded-full border transition-colors duration-150 focus-within:border-fg-3 ${isListening ? 'border-red/60' : 'border-line'}`}>
        <span class={`inline-block w-2 h-2 rounded-full bg-red shrink-0 ${isListening || (run && run.status !== 'done' && run.status !== 'error') ? 'hud-blink' : ''}`} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          class="flex-1 min-w-0 bg-transparent text-[16px] text-fg placeholder:text-fg-3 outline-none"
          placeholder={isListening ? 'Listening…' : conv ? `Continue, ${honorific}… (/new to start over)` : 'Command or question…'}
          value={shown}
          onInput={(e) => {
            histIdx.current = -1;
            setText((e.target as HTMLInputElement).value);
          }}
          onKeyDown={onKey}
          aria-label="Command"
          autocomplete="off"
          spellcheck={false}
          readOnly={isListening}
        />
        {conv && (
          <button
            type="button"
            class="flex items-center gap-1.5 h-9 px-3 rounded-full ds-label hover:text-fg transition-colors"
            onClick={() => {
              newConsoleConversation();
              inputRef.current?.focus();
            }}
            title={`Start a new conversation (${conv.turns} turn${conv.turns === 1 ? '' : 's'} so far) — or type /new`}
            aria-label="Start a new conversation"
          >
            <Plus size={12} strokeWidth={1.75} /> New
          </button>
        )}
        {text.trim() ? (
          <button
            type="button"
            class="flex items-center gap-2 h-11 px-4 rounded-full bg-red text-fg hover:bg-red-hover text-[12px] font-semibold uppercase tracking-[0.08em] transition-colors duration-150"
            onClick={() => submit(text)}
            aria-label="Send command"
          >
            Send <CornerDownLeft size={12} strokeWidth={1.75} />
          </button>
        ) : (
          <span class="hidden sm:inline text-[11px] tracking-[0.12em] text-fg-3 select-none whitespace-nowrap" aria-hidden="true">
            CTRL SPACE
          </span>
        )}
        <div class={voiceSupport.listen ? 'flex' : 'tooltip tooltip-top flex'} data-tip={voiceSupport.listen ? undefined : UNSUPPORTED_LISTEN}>
          <button
            type="button"
            class={`w-11 h-11 flex items-center justify-center rounded-full transition-colors ${
              !voiceSupport.listen ? 'text-fg-3/60 hover:text-fg-2' : isListening ? 'text-red bg-red/10' : 'text-fg-2 hover:text-fg hover:bg-raised'
            }`}
            onClick={onMic}
            aria-label={voiceSupport.listen ? (isListening ? 'Stop listening' : 'Voice input') : UNSUPPORTED_LISTEN}
            aria-disabled={!voiceSupport.listen}
            title={voiceSupport.listen ? (isListening ? 'Stop listening' : 'Voice input') : undefined}
          >
            {isListening ? <Square size={12} strokeWidth={1.75} /> : <Mic size={15} strokeWidth={1.5} />}
          </button>
        </div>
      </div>

      {run ? (
        <ReplyPreview />
      ) : (
        <div class="flex flex-wrap gap-2.5">
          {QUICK.map((q) => (
            <button
              type="button"
              key={q.label}
              class="h-[34px] px-4 rounded-full border border-dashed border-[#3a3a3f] text-[12px] uppercase tracking-[0.08em] text-fg-2 hover:text-fg hover:border-fg-3 outline-none transition-colors duration-150"
              onClick={() => submit(q.prompt)}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReplyPreview() {
  const run = consoleRun.value;
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && run?.status === 'streaming') el.scrollTop = el.scrollHeight;
  }, [run?.reply]);
  if (!run) return null;
  const working = run.status === 'sending' || run.status === 'thinking' || run.status === 'tool' || run.status === 'streaming';
  const statusLabel =
    run.status === 'sending' ? 'Sending' : run.status === 'thinking' ? 'Thinking' : run.status === 'tool' ? 'Tool' : run.status === 'streaming' ? 'Responding' : run.status === 'done' ? 'Done' : 'Error';
  const reply = run.reply.trim();
  return (
    <div class="rounded-[20px] border border-line flex flex-col min-h-0 animate-monarch-fade" role="region" aria-label="Assistant reply" aria-live="polite">
      <div class="flex items-center gap-2 px-4 pt-3 pb-1">
        {(run.turn ?? 1) > 1 && <span class="text-[11px] text-fg-3" title="Turn in this conversation">#{run.turn}</span>}
        <span class="flex-1 min-w-0 truncate text-[12px] text-fg-2" title={run.prompt}>
          {run.prompt}
        </span>
        <Tag tone={run.status === 'error' ? 'red' : working ? 'default' : 'plain'}>{statusLabel}</Tag>
        {run.sessionId && (
          <a href={`#/chat/${run.sessionId}`} class="flex items-center gap-1 text-[12px] text-fg-2 hover:text-fg whitespace-nowrap">
            Open in Chat <ArrowRight size={11} strokeWidth={1.75} />
          </a>
        )}
        <button type="button" class="text-fg-3 hover:text-fg p-0.5" onClick={dismissConsoleRun} aria-label="Dismiss reply" title="Dismiss">
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
      <div ref={bodyRef} class="px-4 pt-1 pb-3 max-h-[clamp(8rem,34vh,24rem)] overflow-y-auto text-[13px] leading-relaxed text-fg">
        {reply ? (
          <Markdown text={run.reply} caret={run.status === 'streaming'} />
        ) : run.status === 'error' ? (
          <span class="text-[#f0686d] text-[12.5px]">{run.error ?? 'The request failed.'}</span>
        ) : (
          <span class="text-[12.5px] text-fg-3">
            {run.status === 'tool' && run.tool ? `Using ${run.tool}…` : conn.value === 'open' ? 'Working…' : 'Queued — core offline'}
          </span>
        )}
        {reply && run.status === 'tool' && run.tool && <div class="text-[11.5px] text-fg-3 mt-1">Using {run.tool}…</div>}
        {reply && run.error && run.status !== 'streaming' && <div class="text-[12px] text-[#f0686d] mt-1">{run.error}</div>}
      </div>
    </div>
  );
}
