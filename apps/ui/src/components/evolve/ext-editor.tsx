/** Extension source viewer + editor (existing and new), and the collapsible API reference drawer. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ExtensionDetail, ExtensionManifest } from '@monarch/shared';
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, Pencil, Save, X } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { navigate, toast, useResource, type Resource } from '../../lib/store.ts';
import { Btn, Panel, Tag } from '../ui.tsx';
import { Markdown } from '../chat/markdown.tsx';
import { CODE_AREA, EvoGate, errMsg, tabIndentHandler } from './common.tsx';

/* ───────────────────────── viewer ───────────────────────── */

export function CodeView(props: { code: string; label?: string; maxH?: string }) {
  const lines = useMemo(() => props.code.replace(/\n$/, '').split('\n'), [props.code]);
  const w = String(lines.length).length;
  return (
    <div class={`overflow-auto border border-line bg-[#121213] ${props.maxH ?? 'max-h-[60vh]'}`} role="region" aria-label={props.label ?? 'Source'} tabIndex={0}>
      <div class="flex min-w-max font-mono text-[12px] leading-[1.6]">
        <pre class="select-none text-right text-fg-3 px-3 py-3 border-r border-line bg-surface/40 sticky left-0" aria-hidden="true" style={{ minWidth: `${w + 2.5}ch` }}>
          {lines.map((_, i) => `${i + 1}\n`).join('')}
        </pre>
        <pre class="text-fg-2 px-3 py-3 whitespace-pre">{lines.join('\n')}</pre>
      </div>
    </div>
  );
}

/* ───────────────────────── existing extension ───────────────────────── */

export function ExtSource(props: { d: ExtensionDetail; onSaved: () => Promise<void> }) {
  const { d } = props;
  const [editing, setEditing] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  if (editing) {
    return (
      <div class="p-4">
        <ExtEditor
          initialManifest={d.manifest}
          initialSource={d.source}
          lockId
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await props.onSaved();
          }}
        />
      </div>
    );
  }
  return (
    <div class="p-4 flex flex-col gap-3">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="font-mono text-[11px] text-fg-2">index.mjs</span>
        <span class="font-mono text-[10px] text-fg-3">
          {d.source.split('\n').length} lines · rev {d.revision}
        </span>
        <span class="ml-auto flex gap-1.5">
          <Btn size="xs" variant="ghost" onClick={() => setShowManifest(!showManifest)} aria-expanded={showManifest}>
            {showManifest ? <ChevronDown size={11} /> : <ChevronRight size={11} />} extension.json
          </Btn>
          <Btn size="xs" onClick={() => setEditing(true)}>
            <Pencil size={11} /> Edit
          </Btn>
        </span>
      </div>
      {showManifest && <CodeView code={JSON.stringify(d.manifest, null, 2)} label="Manifest" maxH="max-h-[40vh]" />}
      <CodeView code={d.source} label="Extension source" />
    </div>
  );
}

/* ───────────────────────── editor ───────────────────────── */

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function ExtEditor(props: {
  initialManifest: ExtensionManifest;
  initialSource: string;
  lockId?: boolean;
  onCancel: () => void;
  onSaved: (id: string) => void | Promise<void>;
}) {
  const [manifest, setManifest] = useState(() => JSON.stringify(props.initialManifest, null, 2));
  const [source, setSource] = useState(props.initialSource);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = manifest !== JSON.stringify(props.initialManifest, null, 2) || source !== props.initialSource;

  const parsed = useMemo((): { m?: ExtensionManifest; err?: string } => {
    try {
      const m = JSON.parse(manifest) as ExtensionManifest;
      if (!m || typeof m !== 'object') return { err: 'Manifest must be a JSON object' };
      if (!m.id || !ID_RE.test(m.id)) return { err: 'manifest.id must be kebab-case, e.g. "hacker-news"' };
      if (props.lockId && m.id !== props.initialManifest.id) return { err: `manifest.id cannot change (was "${props.initialManifest.id}")` };
      if (!m.name) return { err: 'manifest.name is required' };
      if (!Array.isArray(m.permissions)) return { err: 'manifest.permissions must be an array' };
      return { m };
    } catch (e) {
      return { err: `Manifest JSON: ${errMsg(e)}` };
    }
  }, [manifest]);

  const save = async () => {
    if (!parsed.m) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/extensions/${encodeURIComponent(parsed.m.id)}`, { manifest: parsed.m, source, note: note.trim() || undefined });
      toast(`${parsed.m.name} saved`, 'success');
      await props.onSaved(parsed.m.id);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  // Ctrl/Cmd+S saves while the editor is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (parsed.m && !saving) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div class="flex flex-col gap-3">
      <div>
        <label class="hud-label text-[10px] flex items-center gap-2" for="ext-manifest">
          extension.json {parsed.err ? <span class="text-red normal-case tracking-normal font-sans text-[11px]">{parsed.err}</span> : <span class="text-fg-3">valid</span>}
        </label>
        <textarea
          id="ext-manifest"
          class={`${CODE_AREA} mt-1.5 min-h-[150px] ${parsed.err ? 'border-red/50!' : ''}`}
          rows={8}
          spellcheck={false}
          value={manifest}
          onInput={(e) => setManifest((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => tabIndentHandler(e, setManifest)}
        />
      </div>
      <div>
        <label class="hud-label text-[10px] flex items-center gap-2" for="ext-source">
          index.mjs <span class="text-fg-3">{source.split('\n').length} lines · Tab indents, Esc then Tab leaves</span>
        </label>
        <textarea
          id="ext-source"
          class={`${CODE_AREA} mt-1.5 min-h-[360px] h-[52vh]`}
          spellcheck={false}
          wrap="off"
          value={source}
          onInput={(e) => setSource((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => tabIndentHandler(e, setSource)}
        />
      </div>
      <div class="flex items-center gap-2 flex-wrap border-t border-line pt-3">
        <input
          class="hud-input py-1.5! text-[12.5px]! flex-1 min-w-[200px]"
          placeholder="Revision note (optional) — what changed and why"
          aria-label="Revision note"
          value={note}
          onInput={(e) => setNote((e.target as HTMLInputElement).value)}
        />
        <Btn size="sm" variant="ghost" onClick={props.onCancel}>
          <X size={11} /> Cancel
        </Btn>
        <Btn size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={!parsed.m || (!dirty && props.lockId)} title="Save and reload (Ctrl+S)">
          {!saving && <Save size={11} />} Save
        </Btn>
      </div>
      {error && <div class="border border-red/40 bg-red/[0.05] px-3 py-2 font-mono text-[11.5px] text-fg whitespace-pre-wrap break-words">{error}</div>}
    </div>
  );
}

/* ───────────────────────── new extension ───────────────────────── */

const STARTER_MANIFEST: ExtensionManifest = {
  id: 'my-extension',
  name: 'My extension',
  version: '0.1.0',
  description: 'What this extension does, in one line.',
  permissions: [],
  secrets: [],
};

const FALLBACK_SOURCE = `// index.mjs — runs in its own sandboxed Node process.
// Open the API reference below for the full surface (tools, panels, jobs, store, secrets, fetch).

export default function activate(api) {
  const { z } = api;

  api.tool({
    name: 'hello',
    description: 'Greet someone by name',
    risk: 'safe',
    input: { name: z.string().describe('Who to greet') },
    async run({ name }) {
      const count = (api.store.get('greetings', 0) ?? 0) + 1;
      api.store.set('greetings', count);
      return \`Hello, \${name}! (greeting #\${count})\`;
    },
  });

  api.panel({
    id: 'status',
    title: 'Status',
    render: () => ({
      stats: [{ label: 'Greetings', value: String(api.store.get('greetings', 0)) }],
    }),
  });
}
`;

/** first JS fenced block in the reference markdown, used as the starter source when available */
function starterFrom(md: string | undefined): string | null {
  if (!md) return null;
  const m = md.match(/```(?:js|mjs|javascript)\s*\n([\s\S]*?)```/);
  return m && /export\s+default/.test(m[1]) ? m[1] : null;
}

export function NewExtension() {
  const ref = useResource<{ markdown: string }>('/extension-api');
  const starter = starterFrom(ref.data?.markdown);
  const ready = ref.data !== undefined || !!ref.error;
  return (
    <div class="flex flex-col gap-3 min-h-0 flex-1">
      <Panel
        code="EVO.13"
        title="New extension"
        class="flex-1"
        bodyClass="overflow-y-auto"
        right={
          <Btn size="xs" variant="ghost" onClick={() => navigate('evolve/extensions')}>
            <ArrowLeft size={11} /> Back
          </Btn>
        }
      >
        <p class="text-[12.5px] text-fg-2 leading-relaxed mb-3 max-w-[72ch]">
          Edit the manifest and source, then save — the core validates it, records revision 1 and starts it in its own sandbox. Permissions are enforced by the Node permission model; ask only for what you need.
        </p>
        {ready ? (
          <ExtEditor
            key={starter ? 'ref' : 'fallback'}
            initialManifest={STARTER_MANIFEST}
            initialSource={starter ?? FALLBACK_SOURCE}
            onCancel={() => navigate('evolve/extensions')}
            onSaved={(id) => navigate(`evolve/extensions/${encodeURIComponent(id)}`)}
          />
        ) : (
          <div class="font-mono text-[10px] tracking-[0.14em] uppercase text-fg-3 py-6 text-center">Loading template…</div>
        )}
      </Panel>
      <ApiReference res={ref} />
    </div>
  );
}

function ApiReference(props: { res: Resource<{ markdown: string }> }) {
  const [open, setOpen] = useState(false);
  return (
    <section class="hud-panel shrink-0">
      <button class="hud-head w-full text-left hover:bg-white/[0.015]" onClick={() => setOpen(!open)} aria-expanded={open} style={{ borderBottomWidth: open ? undefined : 0 }}>
        <BookOpen size={13} strokeWidth={1.5} class="text-fg-3" />
        <span class="hud-title">API reference</span>
        <span class="ml-auto flex items-center gap-2">
          {props.res.data && <Tag tone="plain">extension-api</Tag>}
          {open ? <ChevronDown size={13} class="text-fg-3" /> : <ChevronRight size={13} class="text-fg-3" />}
        </span>
      </button>
      {open && (
        <div class="hud-body max-h-[50vh] overflow-y-auto">
          <EvoGate res={props.res} loadingLabel="Loading reference">
            {(r) => <Markdown text={r.markdown || '_The core returned an empty reference._'} />}
          </EvoGate>
        </div>
      )}
    </section>
  );
}
