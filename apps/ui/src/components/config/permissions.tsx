/** Config → Permissions: approval mode, memory vault, default coding workspace. */
import { useState } from 'preact/hooks';
import type { PermissionMode } from '@monarch/shared';
import { FolderOpen } from 'lucide-preact';
import { settings } from '../../lib/store.ts';
import { Panel, Tag } from '../ui.tsx';
import { Field, INPUT, RADIO, SaveBar, saveSettings, useDraft } from './fields.tsx';
import { DirBrowser } from './dir-browser.tsx';

const MODES: { id: PermissionMode; title: string; body: string; asks: string; tone: 'ok' | 'warn' | 'red' }[] = [
  {
    id: 'ask',
    title: 'Ask',
    body: 'Monarch asks before any sensitive or dangerous action — sending email or Slack messages, writing files, running shell commands, deleting things.',
    asks: 'asks: sensitive + dangerous',
    tone: 'ok',
  },
  {
    id: 'auto-safe',
    title: 'Auto (safe)',
    body: 'Routine sensitive actions (drafting, editing notes, file writes in workspaces) run without prompting. Only dangerous actions — destructive shell commands, sending on your behalf, deletions — need approval.',
    asks: 'asks: dangerous only',
    tone: 'warn',
  },
  {
    id: 'auto-all',
    title: 'Auto (all)',
    body: 'Never ask. Every tool call runs immediately, including irreversible ones. Use only in sandboxes or when you are watching closely.',
    asks: 'asks: never',
    tone: 'red',
  },
];

interface Slice {
  mode: PermissionMode;
  vaultDir: string;
  defaultWorkspace: string;
}

export function PermissionsSection() {
  const s = settings.value!;
  const [draft, set, dirty, reset] = useDraft<Slice>({ mode: s.permissions.mode, vaultDir: s.memory.vaultDir, defaultWorkspace: s.coding.defaultWorkspace });
  const [saving, setSaving] = useState(false);
  const [browse, setBrowse] = useState<null | 'vault' | 'ws'>(null);
  if (!draft) return null;

  const save = async () => {
    setSaving(true);
    const ok = await saveSettings({ permissions: { mode: draft.mode }, memory: { vaultDir: draft.vaultDir.trim() }, coding: { defaultWorkspace: draft.defaultWorkspace.trim() } } as any);
    setSaving(false);
    if (ok) reset();
  };

  return (
    <div class="flex flex-col gap-3">
      <Panel code="CFG.51" title="Approval mode" right={<Tag tone={MODES.find((m) => m.id === draft.mode)?.tone}>{draft.mode}</Tag>}>
        <div class="flex flex-col gap-2" role="radiogroup">
          {MODES.map((m) => {
            const on = draft.mode === m.id;
            return (
              <label key={m.id} class={`flex gap-3 border p-3 cursor-pointer ${on ? (m.id === 'auto-all' ? 'border-red/60 bg-red/[0.04]' : 'border-fg-3 bg-subtle/40') : 'border-line hover:border-fg-3'}`}>
                <input type="radio" name="perm-mode" class={`${RADIO} mt-0.5`} checked={on} onChange={() => set({ mode: m.id })} />
                <span class="flex-1">
                  <span class="flex items-center gap-2">
                    <span class="font-mono text-[12px] tracking-[0.12em] uppercase text-fg">{m.title}</span>
                    <span class="font-mono text-[10px] text-fg-3">{m.asks}</span>
                  </span>
                  <span class="block text-[12.5px] text-fg-2 mt-1 leading-relaxed">{m.body}</span>
                </span>
              </label>
            );
          })}
        </div>
        <div class="text-[11.5px] text-fg-3 mt-3">Pending approvals appear in the dock at the bottom of the screen. “Always for this session” remembers a tool until the session ends.</div>
      </Panel>

      <Panel code="CFG.52" title="Locations">
        <div class="grid grid-cols-1 gap-4">
          <Field label="Memory vault" hint="Obsidian-compatible folder of markdown notes. Monarch reads and writes its long-term memory here.">
            <div class="flex gap-2">
              <input class={`${INPUT} font-mono`} value={draft.vaultDir} onInput={(e) => set({ vaultDir: (e.target as HTMLInputElement).value })} placeholder="~/.monarch-ai/vault" spellcheck={false} />
              <button class="btn btn-sm btn-outline border-line rounded-[2px] text-fg-2 hover:bg-subtle font-mono font-normal uppercase text-[11px]" onClick={() => setBrowse('vault')}>
                <FolderOpen size={12} /> Browse
              </button>
            </div>
          </Field>
          <Field label="Default coding workspace" hint="Used by Workshop and coding tools when no folder is chosen.">
            <div class="flex gap-2">
              <input
                class={`${INPUT} font-mono`}
                value={draft.defaultWorkspace}
                onInput={(e) => set({ defaultWorkspace: (e.target as HTMLInputElement).value })}
                placeholder="~/code"
                spellcheck={false}
                list="monarch-workspaces"
              />
              <datalist id="monarch-workspaces">
                {s.coding.workspaces.map((w) => (
                  <option key={w} value={w} />
                ))}
              </datalist>
              <button class="btn btn-sm btn-outline border-line rounded-[2px] text-fg-2 hover:bg-subtle font-mono font-normal uppercase text-[11px]" onClick={() => setBrowse('ws')}>
                <FolderOpen size={12} /> Browse
              </button>
            </div>
          </Field>
        </div>
        <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
      </Panel>

      <DirBrowser
        open={browse !== null}
        initialPath={browse === 'vault' ? draft.vaultDir : draft.defaultWorkspace}
        title={browse === 'vault' ? 'Memory vault folder' : 'Default workspace'}
        onPick={(p) => {
          set(browse === 'vault' ? { vaultDir: p } : { defaultWorkspace: p });
          setBrowse(null);
        }}
        onClose={() => setBrowse(null)}
      />
    </div>
  );
}
