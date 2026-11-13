/** Overview command console: input + mic + send, quick actions, and a live reply preview. OWNED BY UI-A. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowRight, CornerDownLeft, Mic, Plus, Square, X } from 'lucide-preact';
import { conn, settings, toast } from '../../lib/store.ts';
import { interimTranscript, listen, listening, stopListening, stripMarkdown, voiceSupport, UNSUPPORTED_LISTEN } from '../../lib/voice.ts';
import { Tag } from '../ui.tsx';
import { activeConversation, consoleConversation, consoleHistory, consoleRun, dismissConsoleRun, newConsoleConversation, runConsoleCommand } from './console-store.ts';

const QUICK = ['Brief me on today', 'Triage my inbox', "What's on Slack?", 'Plan my afternoon'];

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
      toast(UNSUPPORTED_LISTEN, 'warn');
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
    <div class="flex flex-col gap-2.5 w-full">
      <div class={`flex items-stretch border bg-[#121213] transition-colors ${isListening ? 'border-red/60' : 'border-line focus-within:border-fg-3'}`}>
        <span class="flex items-center pl-3 pr-1 font-mono text-[12px] text-fg-3 select-none" aria-hidden="true">
          {isListening ? <span class="inline-block w-1.5 h-1.5 bg-red hud-blink" /> : '›'}
        </span>
        <input
          ref={inputRef}
          type="text"
          class="flex-1 min-w-0 bg-transparent px-2 py-2.5 text-[14px] text-fg placeholder:text-fg-3 outline-none"
          placeholder={isListening ? 'Listening…' : conv ? `Continue, ${honorific}… (/new to start over)` : `Speak or type a command, ${honorific}…`}
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
            class="flex items-center gap-1.5 px-2.5 border-l border-line font-mono text-[10px] tracking-[0.14em] uppercase text-fg-2 hover:text-fg hover:bg-white/[0.03]"
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
        <div class={voiceSupport.listen ? 'flex' : 'tooltip tooltip-top flex'} data-tip={voiceSupport.listen ? undefined : UNSUPPORTED_LISTEN}>
          <button
            type="button"
            class={`w-10 flex items-center justify-center border-l border-line ${
              !voiceSupport.listen ? 'text-fg-3/60 cursor-not-allowed' : isListening ? 'text-red' : 'text-fg-2 hover:text-fg hover:bg-white/[0.03]'
            }`}
            onClick={onMic}
            aria-label={voiceSupport.listen ? (isListening ? 'Stop listening' : 'Voice input') : UNSUPPORTED_LISTEN}
            aria-disabled={!voiceSupport.listen}
            title={voiceSupport.listen ? (isListening ? 'Stop listening' : 'Voice input') : undefined}
          >
            {isListening ? <Square size={12} strokeWidth={1.75} /> : <Mic size={15} strokeWidth={1.5} />}
          </button>
        </div>
        <button
          type="button"
          class={`flex items-center gap-2 px-3.5 border-l font-mono text-[10.5px] tracking-[0.14em] uppercase transition-colors ${
            text.trim() ? 'bg-red border-red text-fg hover:bg-red-hover' : 'border-line text-fg-3'
          }`}
          onClick={() => submit(text)}
          disabled={!text.trim()}
          aria-label="Send command"
        >
          Send <CornerDownLeft size={12} strokeWidth={1.75} />
        </button>
      </div>

      {run ? (
        <ReplyPreview />
      ) : (
        <div class="flex flex-wrap justify-center gap-1">
          {QUICK.map((q) => (
            <button
              type="button"
              key={q}
              class="font-mono text-[10px] tracking-[0.05em] uppercase text-fg-2 border border-line px-[7px] py-1 hover:text-fg hover:border-fg-3 focus-visible:border-fg-3 outline-none transition-colors"
              onClick={() => submit(q)}
            >
              {q}
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
  const reply = stripMarkdown(run.reply);
  return (
    <div class="border border-line bg-surface/80 flex flex-col min-h-0" role="region" aria-label="Assistant reply" aria-live="polite">
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-line">
        <span class="font-mono text-[11px] text-fg-3">›</span>
        {(run.turn ?? 1) > 1 && <span class="font-mono text-[10px] tracking-[0.1em] text-fg-3" title="Turn in this conversation">T{run.turn}</span>}
        <span class="flex-1 min-w-0 truncate text-[12px] text-fg-2" title={run.prompt}>
          {run.prompt}
        </span>
        <Tag tone={run.status === 'error' ? 'red' : working ? 'red' : 'plain'}>{statusLabel}</Tag>
        {run.sessionId && (
          <a href={`#/comms/${run.sessionId}`} class="flex items-center gap-1 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-2 hover:text-fg whitespace-nowrap">
            Open in Comms <ArrowRight size={11} strokeWidth={1.75} />
          </a>
        )}
        <button type="button" class="text-fg-3 hover:text-fg p-0.5" onClick={dismissConsoleRun} aria-label="Dismiss reply" title="Dismiss">
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
      <div ref={bodyRef} class="px-3 py-2 max-h-[clamp(4.5rem,12vh,9rem)] overflow-y-auto text-[13px] leading-relaxed text-fg whitespace-pre-wrap">
        {reply ? (
          <>
            {reply}
            {run.status === 'streaming' && <span class="inline-block w-1.5 h-3 bg-fg-2 ml-0.5 align-[-1px] hud-blink" />}
          </>
        ) : run.status === 'error' ? (
          <span class="text-red font-mono text-[11px]">{run.error ?? 'The request failed.'}</span>
        ) : (
          <span class="font-mono text-[11px] tracking-[0.1em] uppercase text-fg-3">
            {run.status === 'tool' && run.tool ? `Using ${run.tool}…` : conn.value === 'open' ? 'Working…' : 'Queued — core offline'}
          </span>
        )}
        {reply && run.status === 'tool' && run.tool && <div class="font-mono text-[10.5px] tracking-[0.1em] uppercase text-fg-3 mt-1">◇ {run.tool}</div>}
        {reply && run.error && run.status !== 'streaming' && <div class="font-mono text-[11px] text-red mt-1">{run.error}</div>}
      </div>
    </div>
  );
}
