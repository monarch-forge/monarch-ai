/** Config → General: identity, location, assistant persona and voice. */
import { useEffect, useState } from 'preact/hooks';
import type { GeoLocation, Settings } from '@monarch/shared';
import { MapPin, Search, X } from 'lucide-preact';
import { api, qs } from '../../lib/api.ts';
import { settings } from '../../lib/store.ts';
import { Panel, Spinner, ErrorLine, Tag } from '../ui.tsx';
import { Segmented } from '../chat/session-list.tsx';
import { Field, INPUT, SELECT, TEXTAREA, ToggleRow, SaveBar, saveSettings, useDraft } from './fields.tsx';

type Slice = Pick<Settings, 'user' | 'assistant'>;

function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) return;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener?.('voiceschanged', load);
    return () => synth.removeEventListener?.('voiceschanged', load);
  }, []);
  return voices;
}

export function GeneralSection() {
  const s = settings.value!;
  const [draft, set, dirty, reset] = useDraft<Slice>({ user: s.user, assistant: s.assistant });
  const [saving, setSaving] = useState(false);
  const voices = useVoices();
  if (!draft) return null;
  const u = draft.user;
  const a = draft.assistant;
  const setUser = (p: Partial<Slice['user']>) => set({ user: { ...u, ...p } });
  const setAsst = (p: Partial<Slice['assistant']>) => set({ assistant: { ...a, ...p } });
  const setVoice = (p: Partial<Slice['assistant']['voice']>) => setAsst({ voice: { ...a.voice, ...p } });

  const save = async () => {
    setSaving(true);
    const { location: _loc, ...user } = draft.user;
    const ok = await saveSettings({ user, assistant: draft.assistant });
    setSaving(false);
    if (ok) reset();
  };

  return (
    <div class="flex flex-col gap-3">
      <Panel code="CFG.11" title="Identity">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Your name" hint="Used in greetings and briefings.">
            <input class={INPUT} value={u.name} onInput={(e) => setUser({ name: (e.target as HTMLInputElement).value })} placeholder="Tony" />
          </Field>
          <Field label="Honorific" hint="How Monarch addresses you — e.g. “sir”, “boss”, or your first name.">
            <input class={INPUT} value={u.honorific} onInput={(e) => setUser({ honorific: (e.target as HTMLInputElement).value })} placeholder="sir" />
          </Field>
          <Field label="Units">
            <Segmented
              class="max-w-[240px]"
              value={u.units}
              onChange={(v) => setUser({ units: v })}
              options={[
                { value: 'metric', label: 'Metric' },
                { value: 'imperial', label: 'Imperial' },
              ]}
            />
          </Field>
        </div>
        <div class="mt-5">
          <LocationPicker />
        </div>
      </Panel>

      <Panel code="CFG.12" title="Assistant">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Assistant name">
            <input class={INPUT} value={a.name} onInput={(e) => setAsst({ name: (e.target as HTMLInputElement).value })} placeholder="Monarch" />
          </Field>
          <div />
          <Field label="Persona & standing instructions" class="md:col-span-2" hint="Appended to the system prompt for every session. Tone, preferences, things to always/never do.">
            <textarea
              class={`${TEXTAREA} min-h-[120px] font-mono text-[12.5px]`}
              value={a.persona}
              onInput={(e) => setAsst({ persona: (e.target as HTMLTextAreaElement).value })}
              placeholder="Dry wit, concise. Prefer metric. Never send email without showing me the draft first."
            />
          </Field>
        </div>
        <div class="mt-5 grid grid-cols-1 md:grid-cols-2 gap-x-6">
          <div>
            <div class="hud-label text-[10px] mb-1">Voice</div>
            <ToggleRow label="Speak responses" hint="Read assistant replies aloud." checked={a.voice.speak} onChange={(v) => setVoice({ speak: v })} />
            <ToggleRow label="Listen" hint="Enable push-to-talk / wake listening in the UI." checked={a.voice.listen} onChange={(v) => setVoice({ listen: v })} />
          </div>
          <div class="flex flex-col gap-4 pt-5">
            <Field label={`Speech rate · ${a.voice.rate.toFixed(2)}×`}>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={a.voice.rate}
                class="range range-xs [--range-fill:0] text-red"
                onInput={(e) => setVoice({ rate: Number((e.target as HTMLInputElement).value) })}
              />
            </Field>
            <Field label="Voice">
              {voices.length ? (
                <select class={SELECT} value={a.voice.voiceName ?? ''} onChange={(e) => setVoice({ voiceName: (e.target as HTMLSelectElement).value || undefined })}>
                  <option value="">System default</option>
                  {voices.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </select>
              ) : (
                <input class={INPUT} value={a.voice.voiceName ?? ''} onInput={(e) => setVoice({ voiceName: (e.target as HTMLInputElement).value || undefined })} placeholder="System default" />
              )}
            </Field>
          </div>
        </div>
        <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
      </Panel>
    </div>
  );
}

function LocationPicker() {
  const loc = settings.value?.user.location ?? null;
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GeoLocation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const search = async () => {
    if (!q.trim()) return;
    setLoading(true);
    setError(undefined);
    try {
      setResults(await api.get<GeoLocation[]>(`/geocode${qs({ q: q.trim() })}`));
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  const pick = async (g: GeoLocation | null) => {
    const ok = await saveSettings({ user: { location: g } } as any, g ? `Location set: ${g.name}` : 'Location cleared');
    if (ok) {
      setResults(null);
      setQ('');
    }
  };

  return (
    <div>
      <div class="hud-label text-[10px] mb-1.5">Location</div>
      <div class="flex items-center gap-3 mb-2.5 min-h-7">
        <MapPin size={13} strokeWidth={1.5} class="text-fg-3" />
        {loc ? (
          <>
            <span class="text-[13px] text-fg">{loc.name}</span>
            <span class="font-mono text-[11px] text-fg-3">
              {loc.lat.toFixed(4)}, {loc.lon.toFixed(4)}
              {loc.timezone ? ` · ${loc.timezone}` : ''}
            </span>
            <button class="text-fg-3 hover:text-red ml-1" title="Clear location" onClick={() => void pick(null)}>
              <X size={12} />
            </button>
          </>
        ) : (
          <span class="text-[12.5px] text-fg-3">Not set — weather and local time features are disabled.</span>
        )}
      </div>
      <div class="flex gap-2 max-w-[520px]">
        <input
          class={INPUT}
          placeholder="Search a city…"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
        />
        <button class="btn btn-sm btn-outline border-line rounded-[2px] text-fg-2 hover:bg-subtle font-mono font-normal uppercase text-[11px]" onClick={() => void search()} disabled={loading || !q.trim()}>
          {loading ? <Spinner /> : <Search size={12} />} Search
        </button>
      </div>
      <ErrorLine error={error} />
      {results && (
        <div class="mt-2 max-w-[520px] border border-line bg-[#121213]">
          {results.length === 0 && <div class="px-3 py-2 text-[12px] text-fg-3">No places found.</div>}
          {results.map((g, i) => (
            <button key={`${g.lat},${g.lon},${i}`} class="hud-row w-full text-left" onClick={() => void pick(g)}>
              <span class="flex-1 truncate text-[13px] text-fg-2">{g.name}</span>
              <span class="font-mono text-[10px] text-fg-3">
                {g.lat.toFixed(2)}, {g.lon.toFixed(2)}
              </span>
              {g.timezone && <Tag tone="plain">{g.timezone}</Tag>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
