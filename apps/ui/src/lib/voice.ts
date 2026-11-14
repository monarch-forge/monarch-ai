/**
 * Voice I/O through the core's cloud speech service (Config → Voice).
 *  - speak(text): cloud text-to-speech; the core plays it (Linux/macOS) or returns audio the UI plays.
 *  - listen(): the core records the mic and ends on silence (Linux), or the webview's MediaRecorder
 *    records and the core transcribes. Either way the transcript comes from the cloud provider.
 * The webview's own Web Speech APIs are not used: WebKitGTK (Tauri on Linux) ships without them.
 */
import { computed, signal } from '@preact/signals';
import type { VoiceStatus } from '@monarch/shared';
import { api, ApiError, CORE_URL, socket } from './api.ts';
import { onCollectionChanged, settings } from './store.ts';

export const UNSUPPORTED_LISTEN = 'Voice input is not set up — choose a speech-to-text provider in Config → Voice';
export const UNSUPPORTED_SPEAK = 'Voice output is not set up — choose a text-to-speech provider in Config → Voice';

/** core voice status (provider readiness, capture/playback mode) */
export const voiceStatus = signal<VoiceStatus | null>(null);

export async function refreshVoiceStatus(): Promise<VoiceStatus | null> {
  try {
    voiceStatus.value = await api.get<VoiceStatus>('/voice/status');
  } catch {
    /* core offline: keep the last known status */
  }
  return voiceStatus.value;
}

let started = false;
/** start tracking voice status + pipeline events (idempotent) */
export function startVoice(): void {
  if (started) return;
  started = true;
  void refreshVoiceStatus();
  onCollectionChanged('settings', () => void refreshVoiceStatus());
  onCollectionChanged('providers', () => void refreshVoiceStatus());
  socket.onStatus((s) => s === 'open' && void refreshVoiceStatus());
  socket.on((ev) => {
    if (ev.type !== 'voice.state') return;
    voicePhase.value = ev.phase;
    if (ev.phase === 'listening') micLevel.value = ev.level ?? 0;
    else micLevel.value = 0;
    if (ev.phase === 'transcribing' && listening.value) interimTranscript.value = 'Transcribing…';
  });
}

/** core pipeline phase (from ws voice.state) */
export const voicePhase = signal<'idle' | 'listening' | 'transcribing' | 'speaking'>('idle');
/** 0..1 microphone level while the core is listening */
export const micLevel = signal(0);
/** true while the microphone is open (or the take is being transcribed) */
export const listening = signal(false);
/** true while a reply is being spoken */
export const speaking = signal(false);
/** live feedback text while listening */
export const interimTranscript = signal('');

const sttReady = computed(() => !!voiceStatus.value?.stt.ready);
const ttsReady = computed(() => !!voiceStatus.value?.tts.ready);

/** reactive capability flags (read inside components to re-render on change) */
export const voiceSupport = {
  /** a speech-to-text provider is set up and voice input is enabled */
  get listen(): boolean {
    return sttReady.value && !!settings.value?.assistant.voice.listen;
  },
  /** a text-to-speech provider is set up */
  get speak(): boolean {
    return ttsReady.value;
  },
  get sttReady(): boolean {
    return sttReady.value;
  },
  get ttsReady(): boolean {
    return ttsReady.value;
  },
};

/** reduce markdown to something pleasant to read aloud / show as plain text */
export function stripMarkdown(md: string): string {
  return (
    md
      .replace(/```[\s\S]*?```/g, ' (code omitted) ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/^\s*\|?[-:\s|]+\|?\s*$/gm, '')
      .replace(/\|/g, ' ')
      .replace(/^\s*([-*_]\s*){3,}$/gm, '')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/* ─────────────── speaking ─────────────── */

let audioEl: HTMLAudioElement | null = null;
let audioUrl: string | null = null;
let speakSeq = 0;

function dropAudio(): void {
  if (audioEl) {
    audioEl.pause();
    audioEl = null;
  }
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }
}

export function stopSpeaking(): void {
  speakSeq++;
  dropAudio();
  if (speaking.value) void api.post('/voice/stop', {}).catch(() => {});
  speaking.value = false;
}

/**
 * Speak text aloud through the cloud voice. Respects settings.assistant.voice.speak unless `force`
 * (e.g. the "Test voice" button). Resolves when finished; rejects only when `force` is set.
 */
export async function speak(text: string, opts: { force?: boolean } = {}): Promise<void> {
  const cfg = settings.value?.assistant.voice;
  if (!opts.force && !cfg?.speak) return;
  if (!voiceStatus.value) await refreshVoiceStatus();
  if (!ttsReady.value) {
    if (opts.force) throw new Error(UNSUPPORTED_SPEAK);
    return;
  }
  const clean = stripMarkdown(text);
  if (!clean) return;
  stopSpeaking();
  const seq = ++speakSeq;
  speaking.value = true;
  try {
    const res = await fetch(`${CORE_URL}/api/voice/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean }),
    });
    if (!res.ok) {
      const j: any = await res.json().catch(() => null);
      throw new ApiError(res.status, j?.error ?? res.statusText);
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.startsWith('audio/') && seq === speakSeq) {
      // no player in the core: play it here
      audioUrl = URL.createObjectURL(await res.blob());
      audioEl = new Audio(audioUrl);
      await new Promise<void>((resolve) => {
        audioEl!.onended = () => resolve();
        audioEl!.onerror = () => resolve();
        audioEl!.play().catch(() => resolve());
      });
      dropAudio();
    }
  } catch (e) {
    if (opts.force) throw e;
    console.warn('[voice] speak failed', e);
  } finally {
    if (seq === speakSeq) speaking.value = false;
  }
}

/* ─────────────── listening ─────────────── */

let stopBrowserTake: (() => void) | null = null;

/** finish the current take now (it is transcribed) */
export function stopListening(): void {
  if (!listening.value) return;
  if (stopBrowserTake) stopBrowserTake();
  else void api.post('/voice/listen/stop', {}).catch(() => {});
}

/** discard the current take */
export function cancelListening(): void {
  if (!listening.value) return;
  if (stopBrowserTake) stopBrowserTake();
  else void api.post('/voice/listen/cancel', {}).catch(() => {});
}

/**
 * Record one utterance and resolve with its transcript. The take ends on silence (core capture),
 * on stopListening(), or after maxMs. Rejects with a readable Error when not set up or nothing was heard.
 */
export async function listen(opts: { maxMs?: number; force?: boolean } = {}): Promise<string> {
  if (!voiceStatus.value) await refreshVoiceStatus();
  if (!sttReady.value || (!opts.force && !settings.value?.assistant.voice.listen)) throw new Error(UNSUPPORTED_LISTEN);
  if (listening.value) {
    stopListening();
    throw new Error('Already listening');
  }
  stopSpeaking();
  listening.value = true;
  interimTranscript.value = '';
  try {
    let text: string;
    if (voiceStatus.value?.capture === 'core') {
      text = (await api.post<{ text: string }>('/voice/listen', { maxMs: opts.maxMs ?? 30_000 })).text;
    } else {
      text = await browserTake(opts.maxMs ?? 30_000);
    }
    text = (text ?? '').trim();
    if (!text) throw new Error('No speech detected');
    return text;
  } catch (e: any) {
    throw new Error(e?.message ?? 'Voice input failed');
  } finally {
    listening.value = false;
    interimTranscript.value = '';
    micLevel.value = 0;
  }
}

/** record with the webview's MediaRecorder (no recorder in the core), then transcribe in the core */
async function browserTake(maxMs: number): Promise<string> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('This webview cannot record audio, and the core found no recorder');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new Error('Microphone access denied');
  }
  const rec = new MediaRecorder(stream);
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.start();
  interimTranscript.value = 'Listening… click again to finish';
  const timer = window.setTimeout(() => rec.state !== 'inactive' && rec.stop(), maxMs);
  stopBrowserTake = () => rec.state !== 'inactive' && rec.stop();
  await done;
  window.clearTimeout(timer);
  stopBrowserTake = null;
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
  if (blob.size < 2000) throw new Error('No speech detected');
  interimTranscript.value = 'Transcribing…';
  const res = await fetch(`${CORE_URL}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
  const j: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error ?? res.statusText);
  return String(j?.text ?? '');
}
