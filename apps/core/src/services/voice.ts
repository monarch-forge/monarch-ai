/**
 * Cloud voice: speech-to-text and text-to-speech through hosted APIs, with microphone capture and
 * audio playback done by the core itself (the Linux webview, WebKitGTK, ships no speech engines).
 *
 *  STT: OpenAI / Groq / any OpenAI-compatible  POST <base>/audio/transcriptions (multipart, wav)
 *  TTS: OpenAI / any OpenAI-compatible          POST <base>/audio/speech  (response_format wav)
 *       ElevenLabs                              POST /v1/text-to-speech/<voice>?output_format=pcm_24000
 *  Capture: pw-record | parecord | arecord → 16 kHz mono s16 on stdout, simple energy VAD ends the take.
 *  Playback: pw-play | paplay | aplay | afplay (wav), else the UI plays the returned audio.
 *
 * Keys: secrets.voiceKeys[provider] (set in Config → Voice), else the LLM provider key of the same
 * name (secrets.apiKeys.openai / .groq), else the environment. Keys never leave the core.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceKeyProvider, VoiceSideStatus, VoiceStatus, VoiceSttSettings, VoiceTtsSettings } from '@monarch/shared';
import { bus, changed, HttpError, secrets } from '../kernel.ts';
import { getSettings } from '../settings.ts';

/* ─────────────── provider defaults ─────────────── */

const OPENAI_BASE = 'https://api.openai.com/v1';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

const STT_DEFAULT_MODEL: Record<string, string> = {
  openai: 'gpt-4o-mini-transcribe',
  groq: 'whisper-large-v3-turbo',
  custom: 'whisper-1',
};
const TTS_DEFAULT_MODEL: Record<string, string> = {
  openai: 'gpt-4o-mini-tts',
  elevenlabs: 'eleven_flash_v2_5',
  custom: 'tts-1',
};
const TTS_DEFAULT_VOICE: Record<string, string> = {
  openai: 'alloy',
  elevenlabs: 'JBFqnCBsd6RMkjVDRZzb', // "George" (premade; only a fallback — see defaultElevenVoice)
  custom: 'alloy',
};
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const ENV_KEY: Record<VoiceKeyProvider, string | undefined> = {
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  custom: undefined,
};
const KEY_PROVIDERS: VoiceKeyProvider[] = ['openai', 'groq', 'elevenlabs', 'custom'];

function voiceCfg() {
  return getSettings().assistant.voice;
}

/* ─────────────── keys ─────────────── */

function voiceKeys(): Record<string, string> {
  const s = secrets.get() as Record<string, unknown>;
  if (!s.voiceKeys || typeof s.voiceKeys !== 'object') s.voiceKeys = {};
  return s.voiceKeys as Record<string, string>;
}

function resolveKey(p: VoiceKeyProvider): { key?: string; source?: VoiceSideStatus['keySource'] } {
  const own = voiceKeys()[p];
  if (own) return { key: own, source: 'voice' };
  if (p === 'openai' || p === 'groq') {
    const shared = secrets.get().apiKeys[p];
    if (shared) return { key: shared, source: 'provider' };
  }
  const envName = ENV_KEY[p];
  const env = envName ? process.env[envName] : undefined;
  if (env) return { key: env, source: 'env' };
  return {};
}

export function setVoiceKey(provider: string, apiKey: string): VoiceStatus {
  if (!KEY_PROVIDERS.includes(provider as VoiceKeyProvider)) throw new HttpError(400, `Unknown voice provider: ${provider}`);
  const key = (apiKey ?? '').trim();
  if (!key) throw new HttpError(400, 'apiKey is required');
  secrets.update(() => {
    voiceKeys()[provider] = key;
  });
  secrets.flush();
  changed('providers');
  return voiceStatus();
}

export function deleteVoiceKey(provider: string): VoiceStatus {
  secrets.update(() => {
    delete voiceKeys()[provider];
  });
  secrets.flush();
  changed('providers');
  return voiceStatus();
}

/* ─────────────── status ─────────────── */

function which(cmd: string): string | undefined {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', timeout: 2000 });
    const p = r.status === 0 ? r.stdout.split(/\r?\n/)[0]?.trim() : '';
    return p || undefined;
  } catch {
    return undefined;
  }
}

let tools: { recorder?: string; player?: string } | null = null;
function audioTools() {
  if (tools) return tools;
  const recorder = process.platform === 'linux' ? ['pw-record', 'parecord', 'arecord'].find((c) => which(c)) : undefined;
  const player =
    process.platform === 'linux' ? ['pw-play', 'paplay', 'aplay'].find((c) => which(c)) : process.platform === 'darwin' && which('afplay') ? 'afplay' : undefined;
  tools = { recorder, player };
  return tools;
}

function sttBase(c: VoiceSttSettings): string {
  if (c.provider === 'openai') return OPENAI_BASE;
  if (c.provider === 'groq') return GROQ_BASE;
  return c.baseUrl.trim().replace(/\/+$/, '');
}
function ttsBase(c: VoiceTtsSettings): string {
  if (c.provider === 'openai') return OPENAI_BASE;
  if (c.provider === 'elevenlabs') return ELEVEN_BASE;
  return c.baseUrl.trim().replace(/\/+$/, '');
}

function side(provider: string, model: string, needsUrl: string | null): VoiceSideStatus {
  if (provider === 'none') return { provider, ready: false, keySet: false, model: '' };
  const { key, source } = resolveKey(provider as VoiceKeyProvider);
  let error: string | undefined;
  if (needsUrl !== null && !needsUrl) error = 'Set the base URL';
  else if (!key && provider !== 'custom') error = 'Add an API key';
  return { provider, ready: !error, keySet: !!key, keySource: source, model, error };
}

export function voiceStatus(): VoiceStatus {
  const v = voiceCfg();
  const t = audioTools();
  return {
    stt: side(v.stt.provider, v.stt.model || STT_DEFAULT_MODEL[v.stt.provider] || '', v.stt.provider === 'custom' ? sttBase(v.stt) : null),
    tts: side(v.tts.provider, v.tts.model || TTS_DEFAULT_MODEL[v.tts.provider] || '', v.tts.provider === 'custom' ? ttsBase(v.tts) : null),
    capture: t.recorder ? 'core' : 'browser',
    playback: t.player ? 'core' : 'browser',
    recorder: t.recorder,
    player: t.player,
  };
}

function requireReady(which: 'stt' | 'tts'): void {
  const s = voiceStatus()[which];
  if (!s.ready) throw new HttpError(409, `Voice ${which === 'stt' ? 'input' : 'output'} is not set up${s.error ? `: ${s.error}` : ''} (Config → Voice)`);
}

function state(phase: 'idle' | 'listening' | 'transcribing' | 'speaking', level?: number): void {
  bus.broadcast({ type: 'voice.state', phase, level });
}

/* ─────────────── wav helpers ─────────────── */

function wavHeader(dataLen: number, rate: number, channels = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE((rate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}
export function pcmToWav(pcm: Buffer, rate: number): Buffer {
  return Buffer.concat([wavHeader(pcm.length, rate), pcm]);
}

async function apiError(res: Response, label: string): Promise<never> {
  const body: any = await res.json().catch(async () => ({ message: await res.text().catch(() => '') }));
  const msg = body?.error?.message ?? body?.detail?.message ?? body?.detail ?? body?.message ?? '';
  throw new HttpError(502, `${label}: HTTP ${res.status}${msg ? ` — ${String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300)}` : ''}`);
}

/* ─────────────── speech-to-text ─────────────── */

export async function transcribe(audio: Buffer, mime = 'audio/wav'): Promise<string> {
  requireReady('stt');
  const c = voiceCfg().stt;
  const { key } = resolveKey(c.provider as VoiceKeyProvider);
  const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('mpeg') ? 'mp3' : 'wav';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext}`);
  form.append('model', c.model || STT_DEFAULT_MODEL[c.provider] || 'whisper-1');
  form.append('response_format', 'json');
  if (c.language.trim()) form.append('language', c.language.trim());
  state('transcribing');
  try {
    let res: Response;
    try {
      res = await fetch(`${sttBase(c)}/audio/transcriptions`, {
        method: 'POST',
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new HttpError(502, `Speech-to-text unreachable: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) await apiError(res, 'Speech-to-text failed');
    const j: any = await res.json().catch(() => null);
    return String(j?.text ?? '').trim();
  } finally {
    state('idle');
  }
}

/* ─────────────── microphone capture (core) ─────────────── */

const RATE = 16_000;
interface Take {
  proc: ChildProcess;
  chunks: Buffer[];
  finish: (mode: 'stop' | 'cancel') => void;
}
let take: Take | null = null;

function recorderArgs(cmd: string): string[] {
  if (cmd === 'pw-record') return ['--rate', String(RATE), '--channels', '1', '--format', 's16', '-'];
  if (cmd === 'parecord') return ['--raw', '--format=s16le', `--rate=${RATE}`, '--channels=1'];
  return ['-q', '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw'];
}

function rms(buf: Buffer): number {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** record one utterance (ends after ~1.2 s of silence following speech, on stop, or at maxMs) and transcribe it */
export async function listenOnce(opts: { maxMs?: number } = {}): Promise<string> {
  requireReady('stt');
  const recorder = audioTools().recorder;
  if (!recorder) throw new HttpError(501, 'No recorder found (pw-record, parecord or arecord); use browser capture');
  if (take) throw new HttpError(409, 'Already listening');
  const maxMs = Math.min(Math.max(opts.maxMs ?? 30_000, 2000), 120_000);

  const pcm = await new Promise<Buffer | null>((resolve, reject) => {
    const proc = spawn(recorder, recorderArgs(recorder), { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let settled = false;
    let stderr = '';
    let floor = 0;
    let calib = 0;
    let heard = false;
    let lastVoice = Date.now();
    let lastLevel = 0;
    const t0 = Date.now();
    const end = (mode: 'stop' | 'cancel' | 'error', err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      clearInterval(vadTimer);
      try {
        proc.kill('SIGTERM');
      } catch {
        /* gone */
      }
      take = null;
      state('idle');
      if (mode === 'error') reject(err);
      else resolve(mode === 'cancel' ? null : Buffer.concat(chunks));
    };
    take = { proc, chunks, finish: (m) => end(m) };
    proc.stdout!.on('data', (d: Buffer) => {
      chunks.push(d);
      const level = rms(d);
      if (calib < 6) {
        floor = calib === 0 ? level : (floor * calib + level) / (calib + 1);
        calib++;
        return;
      }
      const threshold = Math.max(floor * 2.5, 450);
      if (level > threshold) {
        heard = true;
        lastVoice = Date.now();
      }
      const now = Date.now();
      if (now - lastLevel > 100) {
        lastLevel = now;
        state('listening', Math.min(1, level / 6000));
      }
    });
    proc.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-500)));
    proc.on('error', (e) => end('error', new HttpError(500, `Recorder failed: ${e.message}`)));
    proc.on('close', (code) => {
      if (!settled) {
        if (chunks.length) end('stop');
        else end('error', new HttpError(500, `Recorder exited (${code}) ${stderr.trim()}`.trim()));
      }
    });
    const maxTimer = setTimeout(() => end('stop'), maxMs);
    const vadTimer = setInterval(() => {
      const now = Date.now();
      if (heard && now - lastVoice > 1200) end('stop');
      else if (!heard && now - t0 > 8000) end('stop');
    }, 100);
    state('listening', 0);
  });

  if (!pcm) return '';
  if (pcm.length < RATE * 2 * 0.3) throw new HttpError(422, 'No speech detected');
  return transcribe(pcmToWav(pcm, RATE), 'audio/wav');
}

export function stopListening(mode: 'stop' | 'cancel' = 'stop'): boolean {
  if (!take) return false;
  take.finish(mode);
  return true;
}

/* ─────────────── text-to-speech ─────────────── */

/** synthesize speech; returns a wav buffer */
export async function synthesize(text: string): Promise<Buffer> {
  requireReady('tts');
  const v = voiceCfg();
  const c = v.tts;
  const { key } = resolveKey(c.provider as VoiceKeyProvider);
  const input = text.trim().slice(0, 4000);
  if (!input) throw new HttpError(400, 'Nothing to say');
  const voice = c.voice.trim() || (c.provider === 'elevenlabs' ? await defaultElevenVoice() : TTS_DEFAULT_VOICE[c.provider] || 'alloy');
  const model = c.model.trim() || TTS_DEFAULT_MODEL[c.provider] || 'tts-1';
  const rate = Math.max(0.5, Math.min(2, v.rate || 1));
  let res: Response;
  try {
    if (c.provider === 'elevenlabs') {
      res = await fetch(`${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_24000`, {
        method: 'POST',
        headers: { 'xi-api-key': key ?? '', 'content-type': 'application/json', accept: 'audio/pcm' },
        // ElevenLabs accepts speed 0.7–1.2
        body: JSON.stringify({ text: input, model_id: model, voice_settings: { speed: Math.max(0.7, Math.min(1.2, rate)) } }),
        signal: AbortSignal.timeout(60_000),
      });
    } else {
      res = await fetch(`${ttsBase(c)}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, voice, input, response_format: 'wav', speed: rate }),
        signal: AbortSignal.timeout(60_000),
      });
    }
  } catch (e) {
    throw new HttpError(502, `Text-to-speech unreachable: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) {
    if (c.provider === 'elevenlabs' && res.status === 402) {
      const body: any = await res.json().catch(() => null);
      const msg = String(body?.detail?.message ?? body?.detail ?? '');
      throw new HttpError(
        402,
        /library voice/i.test(msg)
          ? 'This ElevenLabs voice is a library voice, which needs a paid ElevenLabs plan. Pick a voice marked "premade" in Config → Voice (or leave Voice on Default).'
          : `ElevenLabs refused the request (payment required)${msg ? `: ${msg.slice(0, 200)}` : ''}`,
      );
    }
    await apiError(res, 'Text-to-speech failed');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (c.provider === 'elevenlabs') return pcmToWav(buf, 24_000);
  return buf;
}

let player: ChildProcess | null = null;

export function stopSpeaking(): boolean {
  if (!player) return false;
  try {
    player.kill('SIGTERM');
  } catch {
    /* gone */
  }
  player = null;
  state('idle');
  return true;
}

/** play a wav through the system player; resolves when playback ends (or is stopped) */
async function play(wav: Buffer): Promise<void> {
  const cmd = audioTools().player;
  if (!cmd) throw new HttpError(501, 'No audio player found');
  stopSpeaking();
  const dir = mkdtempSync(join(tmpdir(), 'monarch-voice-'));
  const file = join(dir, 'reply.wav');
  writeFileSync(file, wav);
  state('speaking');
  try {
    await new Promise<void>((resolve) => {
      const p = spawn(cmd, [file], { stdio: 'ignore' });
      player = p;
      p.on('error', () => resolve());
      p.on('close', () => resolve());
    });
  } finally {
    player = null;
    state('idle');
    rmSync(dir, { recursive: true, force: true });
  }
}

/** speak text: plays through the core when possible (returns null), else returns the wav for the UI to play */
export async function speak(text: string, opts: { play?: boolean } = {}): Promise<Buffer | null> {
  const wav = await synthesize(text);
  if (opts.play !== false && audioTools().player) {
    await play(wav);
    return null;
  }
  return wav;
}

/* ─────────────── voices ─────────────── */

interface ElevenVoice {
  voice_id: string;
  name?: string;
  category?: string;
  labels?: Record<string, string>;
}

let elevenCache: { key: string; at: number; voices: ElevenVoice[]; tier?: string } | null = null;

/** the account's voices + plan tier (cached 10 min per key) */
async function elevenVoices(): Promise<{ voices: ElevenVoice[]; tier?: string }> {
  const { key } = resolveKey('elevenlabs');
  if (!key) return { voices: [] };
  if (elevenCache && elevenCache.key === key && Date.now() - elevenCache.at < 10 * 60_000) return elevenCache;
  const get = (path: string) =>
    fetch(`${ELEVEN_BASE}${path}`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  const [v, sub]: any[] = await Promise.all([get('/voices'), get('/user/subscription')]);
  if (!v) return { voices: [] };
  elevenCache = { key, at: Date.now(), voices: Array.isArray(v.voices) ? v.voices : [], tier: typeof sub?.tier === 'string' ? sub.tier : undefined };
  return elevenCache;
}

/** default ElevenLabs voice: the account's first premade voice (usable on every plan) */
async function defaultElevenVoice(): Promise<string> {
  const { voices } = await elevenVoices();
  return voices.find((x) => x.category === 'premade')?.voice_id ?? TTS_DEFAULT_VOICE.elevenlabs!;
}

export async function listVoices(): Promise<{ id: string; name: string; hint?: string; disabled?: boolean }[]> {
  const c = voiceCfg().tts;
  if (c.provider === 'elevenlabs') {
    const { voices, tier } = await elevenVoices();
    const free = tier === 'free';
    const rows = voices.map((x) => {
      const premade = x.category === 'premade';
      const desc = [x.labels?.gender, x.labels?.accent, x.labels?.age].filter(Boolean).join(' · ');
      const kind = premade ? 'premade' : x.category === 'cloned' || x.category === 'generated' ? x.category : 'library';
      return {
        id: String(x.voice_id),
        name: String(x.name ?? x.voice_id),
        hint: [kind, desc, free && !premade && kind === 'library' ? 'needs paid plan' : ''].filter(Boolean).join(' · ') || undefined,
        // free plan: library voices are rejected by the API (402)
        disabled: free && kind === 'library' ? true : undefined,
        premade,
      };
    });
    rows.sort((a, b) => Number(b.premade) - Number(a.premade) || a.name.localeCompare(b.name));
    return rows.map(({ premade: _p, ...r }) => r);
  }
  if (c.provider === 'openai' || c.provider === 'custom') return OPENAI_VOICES.map((id) => ({ id, name: id }));
  return [];
}

/** stop everything (shutdown) */
export function stopVoice(): void {
  stopListening('cancel');
  stopSpeaking();
}
