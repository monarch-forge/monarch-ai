/** Config → Voice: cloud speech-to-text and text-to-speech providers, keys, tests and the on/off switches. */
import { useEffect, useState } from 'preact/hooks';
import type { Settings, VoiceKeyProvider, VoiceSideStatus, VoiceSttSettings, VoiceTtsSettings } from '@monarch/shared';
import { KeyRound, Mic, Play, Square } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { settings, toast } from '../../lib/store.ts';
import { listen, micLevel, listening, refreshVoiceStatus, speak, speaking, stopListening, stopSpeaking, voiceStatus } from '../../lib/voice.ts';
import { Panel, Tag } from '../ui.tsx';
import { Field, INPUT, SELECT, ToggleRow, saveSettings } from './fields.tsx';

const BTN = 'btn btn-xs rounded-[2px] font-mono font-normal uppercase tracking-wider text-[10px]';
const BTN_OUT = `${BTN} btn-outline border-line text-fg-2 hover:bg-subtle hover:border-fg-3 hover:text-fg`;

type Voice = Settings['assistant']['voice'];

const STT_PROVIDERS: { id: VoiceSttSettings['provider']; label: string; hint: string }[] = [
  { id: 'none', label: 'Off', hint: '' },
  { id: 'openai', label: 'OpenAI', hint: 'gpt-4o-mini-transcribe / whisper-1' },
  { id: 'groq', label: 'Groq', hint: 'Whisper large v3 turbo — very fast, cheap' },
  { id: 'custom', label: 'OpenAI-compatible', hint: 'any …/v1/audio/transcriptions endpoint' },
];
const TTS_PROVIDERS: { id: VoiceTtsSettings['provider']; label: string; hint: string }[] = [
  { id: 'none', label: 'Off', hint: '' },
  { id: 'openai', label: 'OpenAI', hint: 'gpt-4o-mini-tts — natural voices' },
  { id: 'elevenlabs', label: 'ElevenLabs', hint: 'most lifelike voices' },
  { id: 'custom', label: 'OpenAI-compatible', hint: 'any …/v1/audio/speech endpoint' },
];
const KEY_HELP: Record<string, string> = {
  openai: 'platform.openai.com → API keys',
  groq: 'console.groq.com → API keys',
  elevenlabs: 'elevenlabs.io → Profile → API keys',
  custom: 'optional for local/self-hosted servers',
};

export function VoiceSection() {
  const v = settings.value!.assistant.voice;
  const st = voiceStatus.value;
  useEffect(() => {
    void refreshVoiceStatus();
  }, []);

  const patch = async (p: Partial<Voice>, ok: string | false = false) => {
    const next = await saveSettings({ assistant: { voice: p } }, ok);
    if (next) await refreshVoiceStatus();
  };

  const sttReady = !!st?.stt.ready;
  const ttsReady = !!st?.tts.ready;

  return (
    <div class="flex flex-col gap-3">
      <Panel code="CFG.41" title="Voice" right={<Tag tone={sttReady || ttsReady ? 'ok' : 'warn'}>{sttReady && ttsReady ? 'in + out ready' : sttReady ? 'input ready' : ttsReady ? 'output ready' : 'not set up'}</Tag>}>
        <div class="text-[12.5px] text-fg-2 leading-relaxed max-w-[760px]">
          Monarch talks and listens through cloud speech services. Pick a provider for each direction and add its API key, then switch voice on.
          {st && (
            <span class="text-fg-3">
              {' '}
              Mic: {st.capture === 'core' ? `recorded by the core (${st.recorder}), ends when you stop talking` : 'recorded by the app window'}. Playback:{' '}
              {st.playback === 'core' ? `system audio (${st.player})` : 'app window'}.
            </span>
          )}
        </div>
        <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-6">
          <ToggleRow
            label="Speak responses"
            hint={ttsReady ? 'Read replies aloud (console, and Comms when you asked by voice).' : 'Set up a text-to-speech provider below first.'}
            checked={v.speak && ttsReady}
            disabled={!ttsReady}
            onChange={(on) => void patch({ speak: on }, on ? 'Spoken replies on' : 'Spoken replies off')}
          />
          <ToggleRow
            label="Voice input"
            hint={sttReady ? 'Mic button in the console and Comms.' : 'Set up a speech-to-text provider below first.'}
            checked={v.listen && sttReady}
            disabled={!sttReady}
            onChange={(on) => void patch({ listen: on }, on ? 'Voice input on' : 'Voice input off')}
          />
        </div>
      </Panel>

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <SttPanel v={v} status={st?.stt} onPatch={patch} />
        <TtsPanel v={v} status={st?.tts} onPatch={patch} />
      </div>
    </div>
  );
}

function StatusTag(props: { s?: VoiceSideStatus }) {
  const s = props.s;
  if (!s || s.provider === 'none') return <Tag>off</Tag>;
  if (s.ready) return <Tag tone="ok">ready</Tag>;
  return <Tag tone="warn">{s.error ?? 'not ready'}</Tag>;
}

function KeyField(props: { provider: VoiceKeyProvider; status?: VoiceSideStatus }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const src = props.status?.keySource;
  const save = async () => {
    if (!key.trim()) return;
    setBusy(true);
    try {
      voiceStatus.value = await api.put('/voice/key', { provider: props.provider, apiKey: key.trim() });
      setKey('');
      toast('Key saved', 'success');
    } catch (e: any) {
      toast(`Could not save key: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    try {
      voiceStatus.value = await api.del(`/voice/key/${props.provider}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field
      label={
        <span class="flex items-center gap-1.5">
          <KeyRound size={11} /> API key
          {src === 'provider' && <span class="normal-case tracking-normal text-fg-3">· using your {props.provider} provider key</span>}
          {src === 'env' && <span class="normal-case tracking-normal text-fg-3">· from environment</span>}
        </span>
      }
      hint={KEY_HELP[props.provider]}
    >
      <div class="flex gap-2">
        <input
          class={`${INPUT} font-mono`}
          type="password"
          autoComplete="off"
          placeholder={src === 'voice' ? '•••••••• stored — paste to replace' : src ? 'paste to override' : 'Paste API key'}
          value={key}
          onInput={(e) => setKey((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
        <button class={`${BTN} btn-primary h-8`} disabled={!key.trim() || busy} onClick={() => void save()}>
          Save
        </button>
        {src === 'voice' && (
          <button class={`${BTN_OUT} h-8`} disabled={busy} onClick={() => void clear()}>
            Clear
          </button>
        )}
      </div>
    </Field>
  );
}

/** text input that saves on blur / Enter */
function LazyInput(props: { value: string; placeholder?: string; mono?: boolean; onSave: (v: string) => void }) {
  const [val, setVal] = useState(props.value);
  useEffect(() => setVal(props.value), [props.value]);
  const commit = () => val.trim() !== props.value && props.onSave(val.trim());
  return (
    <input
      class={`${INPUT} ${props.mono ? 'font-mono' : ''}`}
      value={val}
      placeholder={props.placeholder}
      spellcheck={false}
      onInput={(e) => setVal((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

function ProviderPick<T extends string>(props: { value: T; options: { id: T; label: string; hint: string }[]; onChange: (v: T) => void }) {
  const cur = props.options.find((o) => o.id === props.value);
  return (
    <Field label="Provider" hint={cur?.hint || undefined}>
      <select class={SELECT} value={props.value} onChange={(e) => props.onChange((e.target as HTMLSelectElement).value as T)}>
        {props.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function SttPanel(props: { v: Voice; status?: VoiceSideStatus; onPatch: (p: Partial<Voice>, ok?: string | false) => Promise<void> }) {
  const c = props.v.stt;
  const set = (p: Partial<VoiceSttSettings>) => void props.onPatch({ stt: { ...c, ...p } });
  const [heard, setHeard] = useState<string | null>(null);
  const test = async () => {
    if (listening.value) {
      stopListening();
      return;
    }
    setHeard(null);
    try {
      const text = await listen({ force: true, maxMs: 15_000 });
      setHeard(text);
    } catch (e: any) {
      toast(e?.message ?? 'Voice input failed', 'warn');
    }
  };
  return (
    <Panel code="CFG.42" title="Speech to text" right={<StatusTag s={props.status} />}>
      <div class="flex flex-col gap-3">
        <ProviderPick value={c.provider} options={STT_PROVIDERS} onChange={(provider) => set({ provider, model: '' })} />
        {c.provider !== 'none' && (
          <>
            {c.provider === 'custom' && (
              <Field label="Base URL" hint="OpenAI-compatible, usually ends in /v1">
                <LazyInput mono value={c.baseUrl} placeholder="https://api.example.com/v1" onSave={(baseUrl) => set({ baseUrl })} />
              </Field>
            )}
            <KeyField provider={c.provider as VoiceKeyProvider} status={props.status} />
            <div class="grid grid-cols-2 gap-3">
              <Field label="Model" hint={props.status?.model ? `default: ${props.status.model}` : undefined}>
                <LazyInput mono value={c.model} placeholder={props.status?.model || 'provider default'} onSave={(model) => set({ model })} />
              </Field>
              <Field label="Language" hint="e.g. en, id — blank = auto">
                <LazyInput mono value={c.language} placeholder="auto" onSave={(language) => set({ language })} />
              </Field>
            </div>
            <div class="flex items-center gap-3">
              <button class={listening.value ? `${BTN} btn-primary h-8` : `${BTN_OUT} h-8`} disabled={!props.status?.ready} onClick={() => void test()}>
                {listening.value ? <Square size={11} /> : <Mic size={11} />} {listening.value ? 'Stop' : 'Test mic'}
              </button>
              {listening.value && (
                <span class="flex-1 h-1.5 bg-subtle max-w-[220px]">
                  <span class="block h-full bg-red transition-[width] duration-100" style={{ width: `${Math.round(micLevel.value * 100)}%` }} />
                </span>
              )}
              {!listening.value && heard !== null && <span class="text-[12.5px] text-fg truncate">“{heard}”</span>}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

function TtsPanel(props: { v: Voice; status?: VoiceSideStatus; onPatch: (p: Partial<Voice>, ok?: string | false) => Promise<void> }) {
  const c = props.v.tts;
  const set = (p: Partial<VoiceTtsSettings>) => void props.onPatch({ tts: { ...c, ...p } });
  const [voices, setVoices] = useState<{ id: string; name: string; hint?: string; disabled?: boolean }[]>([]);
  const [rate, setRate] = useState(props.v.rate);
  useEffect(() => setRate(props.v.rate), [props.v.rate]);
  const ready = !!props.status?.ready;
  useEffect(() => {
    if (c.provider === 'none' || !ready) {
      setVoices([]);
      return;
    }
    api
      .get<{ id: string; name: string; hint?: string; disabled?: boolean }[]>('/voice/voices')
      .then(setVoices)
      .catch(() => setVoices([]));
  }, [c.provider, ready]);

  const test = async () => {
    if (speaking.value) {
      stopSpeaking();
      return;
    }
    const name = settings.value?.assistant.name || 'Monarch';
    const hon = settings.value?.user.honorific || 'sir';
    try {
      await speak(`Good day, ${hon}. ${name} voice systems are online.`, { force: true });
    } catch (e: any) {
      toast(e?.message ?? 'Speech failed', 'error');
    }
  };

  return (
    <Panel code="CFG.43" title="Text to speech" right={<StatusTag s={props.status} />}>
      <div class="flex flex-col gap-3">
        <ProviderPick value={c.provider} options={TTS_PROVIDERS} onChange={(provider) => set({ provider, model: '', voice: '' })} />
        {c.provider !== 'none' && (
          <>
            {c.provider === 'custom' && (
              <Field label="Base URL" hint="OpenAI-compatible, usually ends in /v1">
                <LazyInput mono value={c.baseUrl} placeholder="https://api.example.com/v1" onSave={(baseUrl) => set({ baseUrl })} />
              </Field>
            )}
            <KeyField provider={c.provider as VoiceKeyProvider} status={props.status} />
            <div class="grid grid-cols-2 gap-3">
              <Field
                label="Voice"
                hint={
                  voices.find((x) => x.id === c.voice)?.disabled ? (
                    <span class="text-warning">This voice needs a paid ElevenLabs plan — pick a premade voice.</span>
                  ) : c.provider === 'elevenlabs' && voices.some((x) => x.disabled) ? (
                    'Free plan: premade voices only.'
                  ) : undefined
                }
              >
                {voices.length ? (
                  <select class={SELECT} value={c.voice} onChange={(e) => set({ voice: (e.target as HTMLSelectElement).value })}>
                    <option value="">Default</option>
                    {voices.map((x) => (
                      <option key={x.id} value={x.id} disabled={x.disabled && x.id !== c.voice}>
                        {x.name}
                        {x.hint ? ` — ${x.hint}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <LazyInput mono value={c.voice} placeholder={c.provider === 'elevenlabs' ? 'voice id' : 'alloy'} onSave={(voice) => set({ voice })} />
                )}
              </Field>
              <Field label="Model" hint={props.status?.model ? `default: ${props.status.model}` : undefined}>
                <LazyInput mono value={c.model} placeholder={props.status?.model || 'provider default'} onSave={(model) => set({ model })} />
              </Field>
            </div>
            <Field label={`Speech rate · ${rate.toFixed(2)}×`}>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={rate}
                class="range range-xs [--range-fill:0] text-red"
                onInput={(e) => setRate(Number((e.target as HTMLInputElement).value))}
                onChange={(e) => void props.onPatch({ rate: Number((e.target as HTMLInputElement).value) })}
              />
            </Field>
            <div>
              <button class={speaking.value ? `${BTN} btn-primary h-8` : `${BTN_OUT} h-8`} disabled={!ready} onClick={() => void test()}>
                {speaking.value ? <Square size={11} /> : <Play size={11} />} {speaking.value ? 'Stop' : 'Test voice'}
              </button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
