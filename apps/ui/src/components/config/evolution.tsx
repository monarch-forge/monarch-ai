/** Config → Evolution: self-modification switches (Settings.evolution). */
import { useState } from 'preact/hooks';
import type { Settings } from '@monarch/shared';
import { settings } from '../../lib/store.ts';
import { Panel, Tag } from '../ui.tsx';
import { Field, SELECT, SaveBar, ToggleRow, saveSettings, useDraft } from './fields.tsx';

type Evo = Settings['evolution'];
const DEFAULTS: Evo = { enabled: true, autoEnable: true, reflect: 'off', deferTools: true };

export function EvolutionSection() {
  const s = settings.value!;
  const [draft, set, dirty, reset] = useDraft<Evo>({ ...DEFAULTS, ...(s.evolution ?? {}) });
  const [saving, setSaving] = useState(false);
  if (!draft) return null;

  const save = async () => {
    setSaving(true);
    const ok = await saveSettings({ evolution: draft });
    setSaving(false);
    if (ok) reset();
  };

  return (
    <div class="flex flex-col gap-3">
      <Panel code="CFG.61" title="Self-modification" right={<Tag tone={draft.enabled ? 'red' : 'plain'}>{draft.enabled ? 'enabled' : 'off'}</Tag>}>
        <div class="flex flex-col divide-y divide-line">
          <ToggleRow
            label="Let Monarch extend itself"
            hint="The agent may write and modify its own extensions and skills. Every change is versioned, logged in Evolve → Timeline, and still approval-gated by risk."
            checked={draft.enabled}
            onChange={(v) => set({ enabled: v })}
          />
          <ToggleRow
            label="Enable new extensions immediately"
            hint="Off: extensions Monarch writes wait, disabled, until you review them in Evolve. Skills are always live."
            checked={draft.autoEnable}
            onChange={(v) => set({ autoEnable: v })}
            disabled={!draft.enabled}
          />
          <ToggleRow
            label="Load tools on demand"
            hint="Only core tools are sent with every prompt; the rest are discovered through tool search. Keeps the context lean as the catalog grows."
            checked={draft.deferTools}
            onChange={(v) => set({ deferTools: v })}
          />
        </div>
      </Panel>
      <Panel code="CFG.62" title="Reflection">
        <Field label="Automatic reflection" hint="A periodic self-review of recent sessions that turns friction — repeated manual steps, failing tools, missing capabilities — into proposals you can build or dismiss." htmlFor="evo-reflect">
          <select id="evo-reflect" class={`${SELECT} max-w-[240px]`} value={draft.reflect} onChange={(e) => set({ reflect: (e.target as HTMLSelectElement).value as Evo['reflect'] })}>
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>
        <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
      </Panel>
    </div>
  );
}
