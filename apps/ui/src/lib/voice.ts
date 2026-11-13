/**
 * Voice I/O over the Web Speech API (feature-detected). OWNED BY UI-A.
 *  - speak(text): speechSynthesis, honours settings.assistant.voice.{speak,rate,voiceName}; strips markdown.
 *  - listen(): SpeechRecognition / webkitSpeechRecognition → final transcript.
 * WebKitGTK (Tauri on Linux) usually ships without SpeechRecognition — callers should check `voiceSupport.listen`.
 */
import { signal } from '@preact/signals';
import { settings } from './store.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const w: any = typeof window !== 'undefined' ? window : {};
const Recognition: any = w.SpeechRecognition ?? w.webkitSpeechRecognition;

export const voiceSupport = {
  speak: typeof w.speechSynthesis !== 'undefined' && typeof w.SpeechSynthesisUtterance !== 'undefined',
  listen: typeof Recognition === 'function',
};

export const UNSUPPORTED_LISTEN = 'Voice input not supported in this webview';
export const UNSUPPORTED_SPEAK = 'Speech synthesis not supported in this webview';

/** true while the microphone is open */
export const listening = signal(false);
/** true while an utterance is being spoken */
export const speaking = signal(false);
/** interim transcript while listening (for live feedback) */
export const interimTranscript = signal('');

/** reduce markdown to something pleasant to read aloud / show as plain text */
export function stripMarkdown(md: string): string {
  return (
    md
      // fenced code blocks → omitted
      .replace(/```[\s\S]*?```/g, ' (code omitted) ')
      // images ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // links [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // wikilinks [[a|b]] → b / a
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      // inline code
      .replace(/`([^`]+)`/g, '$1')
      // headings, blockquotes, list bullets
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      // emphasis
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      // tables / rules
      .replace(/^\s*\|?[-:\s|]+\|?\s*$/gm, '')
      .replace(/\|/g, ' ')
      .replace(/^\s*([-*_]\s*){3,}$/gm, '')
      // bare urls are noise when spoken
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function pickVoice(name?: string): SpeechSynthesisVoice | undefined {
  if (!voiceSupport.speak) return undefined;
  const voices = w.speechSynthesis.getVoices() as SpeechSynthesisVoice[];
  if (!voices.length) return undefined;
  if (name) {
    const exact = voices.find((v) => v.name === name);
    if (exact) return exact;
    const loose = voices.find((v) => v.name.toLowerCase().includes(name.toLowerCase()));
    if (loose) return loose;
  }
  const lang = (navigator.language || 'en').slice(0, 2);
  return voices.find((v) => v.default && v.lang.startsWith(lang)) ?? voices.find((v) => v.lang.startsWith(lang)) ?? voices[0];
}

/** available synthesis voices (may be empty until the browser loads them) */
export function listVoices(): SpeechSynthesisVoice[] {
  return voiceSupport.speak ? (w.speechSynthesis.getVoices() as SpeechSynthesisVoice[]) : [];
}

export function stopSpeaking(): void {
  if (!voiceSupport.speak) return;
  w.speechSynthesis.cancel();
  speaking.value = false;
}

/**
 * Speak text aloud. Respects settings.assistant.voice unless `force` is set
 * (e.g. a "test voice" button). Resolves when finished (or immediately when disabled/unsupported).
 */
export function speak(text: string, opts: { force?: boolean; rate?: number; voiceName?: string } = {}): Promise<void> {
  const cfg = settings.value?.assistant.voice;
  if (!voiceSupport.speak) return Promise.resolve();
  if (!opts.force && !cfg?.speak) return Promise.resolve();
  const clean = stripMarkdown(text);
  if (!clean) return Promise.resolve();
  w.speechSynthesis.cancel();
  return new Promise<void>((resolve) => {
    const u = new w.SpeechSynthesisUtterance(clean.slice(0, 4000)) as SpeechSynthesisUtterance;
    const rate = opts.rate ?? cfg?.rate ?? 1;
    u.rate = Math.max(0.5, Math.min(2, rate || 1));
    const v = pickVoice(opts.voiceName ?? cfg?.voiceName);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    const done = () => {
      speaking.value = false;
      resolve();
    };
    u.onstart = () => (speaking.value = true);
    u.onend = done;
    u.onerror = done;
    w.speechSynthesis.speak(u);
  });
}

let active: any = null;

/** stop an in-progress listen(); the pending promise resolves with what was heard so far */
export function stopListening(): void {
  try {
    active?.stop();
  } catch {
    /* ignore */
  }
}

/**
 * Listen for one utterance and resolve with the final transcript.
 * Rejects with a readable Error when unsupported, denied, or nothing was heard.
 */
export function listen(opts: { lang?: string; timeoutMs?: number } = {}): Promise<string> {
  if (!voiceSupport.listen) return Promise.reject(new Error(UNSUPPORTED_LISTEN));
  if (active) {
    stopListening();
    return Promise.reject(new Error('Already listening'));
  }
  stopSpeaking();
  return new Promise<string>((resolve, reject) => {
    let rec: any;
    try {
      rec = new Recognition();
    } catch {
      reject(new Error(UNSUPPORTED_LISTEN));
      return;
    }
    active = rec;
    rec.lang = opts.lang ?? navigator.language ?? 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let finalText = '';
    let failed: string | null = null;
    const timer = window.setTimeout(() => stopListening(), opts.timeoutMs ?? 15000);
    rec.onstart = () => {
      listening.value = true;
      interimTranscript.value = '';
    };
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      interimTranscript.value = (finalText + ' ' + interim).trim();
    };
    rec.onerror = (e: any) => {
      const code = e?.error as string | undefined;
      failed =
        code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Microphone access denied'
          : code === 'no-speech'
            ? 'No speech detected'
            : code === 'audio-capture'
              ? 'No microphone found'
              : code === 'network'
                ? 'Speech service unreachable'
                : code === 'aborted'
                  ? 'Listening cancelled'
                  : `Voice input failed${code ? ` (${code})` : ''}`;
    };
    rec.onend = () => {
      window.clearTimeout(timer);
      listening.value = false;
      active = null;
      const text = (finalText || interimTranscript.value).trim();
      interimTranscript.value = '';
      if (text) resolve(text);
      else reject(new Error(failed ?? 'No speech detected'));
    };
    try {
      rec.start();
    } catch (e: any) {
      window.clearTimeout(timer);
      active = null;
      listening.value = false;
      reject(new Error(e?.message ?? 'Voice input failed'));
    }
  });
}
