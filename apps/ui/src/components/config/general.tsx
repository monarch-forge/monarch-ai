/** Config → General: identity, location, assistant persona and voice. */
import { useState } from 'preact/hooks';
import type { GeoLocation, Settings } from '@monarch/shared';
import { MapPin, Search, X } from 'lucide-preact';
import { api, qs } from '../../lib/api.ts';
import { settings } from '../../lib/store.ts';
import { Panel, Spinner, ErrorLine, Tag, Pills } from '../ui.tsx';
import { Field, INPUT, SELECT, TEXTAREA, ToggleRow, SaveBar, saveSettings, useDraft } from './fields.tsx';

type Slice = Pick<Settings, 'user' | 'assistant'>;

export function GeneralSection() {
  const s = settings.value!;
  const [draft, set, dirty, reset] = useDraft<Slice>({ user: s.user, assistant: s.assistant });
  const [saving, setSaving] = useState(false);
  if (!draft) return null;
  const u = draft.user;
  const a = draft.assistant;
  const setUser = (p: Partial<Slice['user']>) => set({ user: { ...u, ...p } });
  const setAsst = (p: Partial<Slice['assistant']>) => set({ assistant: { ...a, ...p } });

  const save = async () => {
    setSaving(true);
    const { location: _loc, ...user } = draft.user;
    // voice lives in Config → Voice; never send a stale copy back
    const { voice: _voice, ...assistant } = draft.assistant;
    const ok = await saveSettings({ user, assistant });
    setSaving(false);
    if (ok) reset();
  };

  return (
    <div class="flex flex-col gap-3">
      <Panel title="Identity">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Your name" hint="Used in greetings and briefings.">
            <input class={INPUT} value={u.name} onInput={(e) => setUser({ name: (e.target as HTMLInputElement).value })} placeholder="Tony" />
          </Field>
          <Field label="Honorific" hint="How Monarch addresses you — e.g. “sir”, “boss”, or your first name.">
            <input class={INPUT} value={u.honorific} onInput={(e) => setUser({ honorific: (e.target as HTMLInputElement).value })} placeholder="sir" />
          </Field>
          <Field label="Units">
            <Pills
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

      <Panel title="Appearance">
        <Field label="Text size" hint="Scales the whole interface. Saved on this device only.">
          <TextSizePicker />
        </Field>
      </Panel>

      <Panel title="Assistant">
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
        <div class="mt-5 text-[12px] text-fg-3">
          Voice input and spoken replies are set up under{' '}
          <a href="#/config/voice" class="underline underline-offset-2 text-fg-2">
            Config → Voice
          </a>
          .
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
        <button class="btn btn-sm btn-outline border-line rounded-[var(--radius-control)] text-fg-2 hover:bg-subtle font-normal text-[12px]" onClick={() => void search()} disabled={loading || !q.trim()}>
          {loading ? <Spinner /> : <Search size={12} />} Search
        </button>
      </div>
      <ErrorLine error={error} />
      {results && (
        <div class="mt-2 max-w-[520px] border border-line bg-base-200">
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

type TextSize = 's' | 'm' | 'l' | 'xl';
const TEXT_SIZE_KEY = 'monarch.textSize';

function TextSizePicker() {
  const [size, setSize] = useState<TextSize>(() => {
    try {
      return (localStorage.getItem(TEXT_SIZE_KEY) as TextSize) || 'm';
    } catch {
      return 'm';
    }
  });
  const apply = (v: TextSize) => {
    setSize(v);
    const root = document.documentElement;
    if (v === 'm') delete root.dataset.textSize;
    else root.dataset.textSize = v;
    try {
      if (v === 'm') localStorage.removeItem(TEXT_SIZE_KEY);
      else localStorage.setItem(TEXT_SIZE_KEY, v);
    } catch {
      /* storage blocked: still applied for this session */
    }
  };
  return (
    <Pills
      value={size}
      onChange={apply}
      options={[
        { value: 's', label: 'S', title: 'Small' },
        { value: 'm', label: 'M', title: 'Default' },
        { value: 'l', label: 'L', title: 'Large' },
        { value: 'xl', label: 'XL', title: 'Extra large' },
      ]}
    />
  );
}
