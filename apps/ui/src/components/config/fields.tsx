/** Form primitives + settings persistence for Config (and Workshop). daisyUI inputs restyled to the HUD theme. */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Settings } from '@monarch/shared';
import { api } from '../../lib/api.ts';
import { settings, toast } from '../../lib/store.ts';

export const INPUT = 'input input-sm w-full bg-[#121213] border-line text-[13px] rounded-[2px] focus:outline-none focus-within:outline-none focus:border-fg-3 focus-within:border-fg-3';
export const SELECT = 'select select-sm w-full bg-[#121213] border-line text-[13px] rounded-[2px] focus:outline-none focus:border-fg-3';
export const TEXTAREA = 'textarea textarea-sm w-full bg-[#121213] border-line text-[13px] rounded-[2px] leading-relaxed focus:outline-none focus:border-fg-3';
export const TOGGLE = 'toggle toggle-sm rounded-[2px] border-line checked:bg-red checked:border-red checked:text-fg';
export const RADIO = 'radio radio-sm border-line checked:bg-red checked:border-red checked:text-fg';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object | null ? DeepPartial<T[K]> | T[K] : T[K] };
export type SettingsPatch = DeepPartial<Settings>;

/** PUT /api/settings (deep-merged server side) and update the global signal */
export async function saveSettings(patch: SettingsPatch, okText: string | false = 'Settings saved'): Promise<Settings | null> {
  try {
    const next = await api.put<Settings>('/settings', patch);
    if (next && typeof next === 'object') settings.value = next;
    if (okText) toast(okText, 'success');
    return next;
  } catch (e: any) {
    toast(`Save failed: ${e?.message ?? e}`, 'error');
    return null;
  }
}

/**
 * Local editable copy of some settings slice. Re-syncs from the source while not dirty.
 * Returns [draft, set(partial), dirty, reset] — call reset() after a successful save to re-sync.
 */
export function useDraft<T extends object>(source: T | undefined | null): [T | null, (p: Partial<T>) => void, boolean, () => void] {
  const [draft, setDraft] = useState<T | null>(source ? structuredClone(source) : null);
  const [dirty, setDirty] = useState(false);
  const srcKey = source ? JSON.stringify(source) : '';
  useEffect(() => {
    if (!dirty && source) setDraft(structuredClone(source));
  }, [srcKey, dirty]);
  return [
    draft,
    (p) => {
      setDraft((d) => (d ? { ...d, ...p } : d));
      setDirty(true);
    },
    dirty,
    () => setDirty(false),
  ];
}

export function Field(props: { label: string; hint?: ComponentChildren; children: ComponentChildren; class?: string; htmlFor?: string }) {
  return (
    <div class={`flex flex-col gap-1.5 ${props.class ?? ''}`}>
      <label class="hud-label text-[10px]" for={props.htmlFor}>
        {props.label}
      </label>
      {props.children}
      {props.hint && <div class="text-[11.5px] text-fg-3 leading-snug">{props.hint}</div>}
    </div>
  );
}

export function ToggleRow(props: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label class={`flex items-start gap-3 py-2 cursor-pointer ${props.disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <input type="checkbox" class={`${TOGGLE} mt-0.5`} checked={props.checked} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} disabled={props.disabled} />
      <span class="flex-1">
        <span class="block text-[13px] text-fg">{props.label}</span>
        {props.hint && <span class="block text-[11.5px] text-fg-3 mt-0.5">{props.hint}</span>}
      </span>
    </label>
  );
}

/** footer bar with Save / Revert, shown inside a panel */
export function SaveBar(props: { dirty: boolean; saving?: boolean; onSave: () => void; onReset: () => void; note?: ComponentChildren }) {
  return (
    <div class="flex items-center gap-2 pt-3 mt-4 border-t border-line">
      <span class="font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 flex-1">{props.note ?? (props.dirty ? <span class="text-warning">unsaved changes</span> : 'saved')}</span>
      <button class="btn btn-sm btn-ghost rounded-[2px] font-mono font-normal uppercase tracking-wider text-[11px] text-fg-2" disabled={!props.dirty || props.saving} onClick={props.onReset}>
        Revert
      </button>
      <button class="btn btn-sm btn-primary rounded-[2px] font-mono font-normal uppercase tracking-wider text-[11px]" disabled={!props.dirty || props.saving} onClick={props.onSave}>
        {props.saving && <span class="loading loading-spinner loading-xs" />}
        Save
      </button>
    </div>
  );
}

/** "Loading settings…" / offline placeholder */
export function SettingsGate(props: { children: ComponentChildren }) {
  if (!settings.value) {
    return <div class="font-mono text-[11px] uppercase tracking-[0.14em] text-fg-3 py-10 text-center">Waiting for core settings…</div>;
  }
  return <>{props.children}</>;
}

export function Kbd(props: { children: ComponentChildren }) {
  return <code class="font-mono text-[11.5px] bg-subtle text-fg px-1.5 py-0.5 rounded-[2px]">{props.children}</code>;
}
