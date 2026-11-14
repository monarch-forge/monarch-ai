/** Extension detail sections: overview (permissions, secrets, tools + test, jobs), panels, logs, history. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ExtensionDetail, ExtensionToolInfo, PanelContent } from '@monarch/shared';
import { Check, ExternalLink, FlaskConical, KeyRound, Play, RefreshCw, Undo2 } from 'lucide-preact';
import { api, ApiError, openExternal } from '../../lib/api.ts';
import { toast, useResource } from '../../lib/store.ts';
import { Btn, Tag, Spinner, fmt } from '../ui.tsx';
import { Markdown } from '../chat/markdown.tsx';
import { useConfirm } from '../mail/kit.tsx';
import { CODE_AREA, EvoGate, EvoNote, PERMISSION_HINT, PermTag, RiskTag, SectionHead, ago, errMsg, stamp, tabIndentHandler } from './common.tsx';

/* ───────────────────────── overview ───────────────────────── */

export function ExtOverview(props: { d: ExtensionDetail; onChanged: () => Promise<void> }) {
  const { d } = props;
  return (
    <div class="p-4 flex flex-col gap-6">
      <section>
        <SectionHead label="Permissions" count={d.permissions.length} />
        {d.permissions.length ? (
          <ul class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {d.permissions.map((p) => (
              <li key={p} class="flex items-start gap-2.5 border border-line px-3 py-2">
                <PermTag perm={p} />
                <span class="text-[12px] text-fg-3 leading-snug">{PERMISSION_HINT[p] ?? 'Custom permission'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div class="text-[12px] text-fg-3">None — runs fully sandboxed with access only to its own data folder.</div>
        )}
      </section>

      {d.secrets.length > 0 && (
        <section>
          <SectionHead label="Secrets" count={d.secrets.length} right={<span class="font-mono text-[10px] text-fg-3">values never leave the core</span>} />
          <div class="flex flex-col divide-y divide-line border border-line">
            {d.secrets.map((s) => (
              <SecretRow key={s.name} extId={d.id} name={s.name} set={s.set} onSaved={props.onChanged} />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHead label="Tools" count={d.tools.length} right={<span class="font-mono text-[10px] text-fg-3">{fmt.num(d.calls)} calls served</span>} />
        {d.tools.length ? (
          <div class="flex flex-col gap-2">
            {d.tools.map((t) => (
              <ToolRow key={t.name} extId={d.id} tool={t} disabled={!d.enabled || d.status !== 'active'} />
            ))}
          </div>
        ) : (
          <div class="text-[12px] text-fg-3">This extension contributes no tools.</div>
        )}
      </section>

      {d.jobs.length > 0 && (
        <section>
          <SectionHead label="Jobs" count={d.jobs.length} />
          <div class="border border-line divide-y divide-line">
            {d.jobs.map((j) => (
              <div key={j.id} class="px-3 py-2 flex items-start gap-3 flex-wrap">
                <span class={`inline-block w-1.5 h-1.5 mt-1.5 ${j.lastError ? 'bg-red' : j.lastRunAt ? 'bg-fg-2' : 'border border-fg-3'}`} />
                <span class="font-mono text-[12px] text-fg">{j.id}</span>
                <span class="font-mono text-[10px] tracking-[0.1em] uppercase text-fg-3 mt-0.5">every {everyLabel(j.everyMinutes)}</span>
                <span class="ml-auto font-mono text-[10px] text-fg-3 mt-0.5" title={j.lastRunAt ? stamp(j.lastRunAt) : undefined}>
                  {j.lastRunAt ? `ran ${ago(j.lastRunAt)}` : 'not run yet'}
                </span>
                {j.lastError && <div class="basis-full font-mono text-[11px] text-red break-words pl-4">{j.lastError}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHead label="Record" />
        <dl class="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-[12px]">
          <Meta k="Created" v={stamp(d.createdAt)} />
          <Meta k="Updated" v={stamp(d.updatedAt)} />
          <Meta k="Revision" v={String(d.revision)} />
          <Meta k="Origin" v={d.origin} />
        </dl>
      </section>
    </div>
  );
}

function Meta(props: { k: string; v: string }) {
  return (
    <div class="min-w-0">
      <dt class="hud-label text-[10px]">{props.k}</dt>
      <dd class="text-fg-2 mt-0.5 truncate">{props.v}</dd>
    </div>
  );
}

function everyLabel(m: number): string {
  if (m < 60) return `${m}m`;
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

function SecretRow(props: { extId: string; name: string; set: boolean; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (v: string) => {
    setBusy(true);
    try {
      await api.put(`/extensions/${encodeURIComponent(props.extId)}/secrets`, { name: props.name, value: v });
      toast(v ? `${props.name} saved` : `${props.name} cleared`, 'success');
      setValue('');
      setEditing(false);
      await props.onSaved();
    } catch (e) {
      toast(`Secret update failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="px-3 py-2 flex items-center gap-3 flex-wrap">
      <KeyRound size={12} class="text-fg-3 shrink-0" />
      <span class="font-mono text-[12px] text-fg">{props.name}</span>
      <Tag tone={props.set ? 'ok' : 'warn'}>{props.set ? 'set' : 'unset'}</Tag>
      {editing ? (
        <form
          class="flex items-center gap-1.5 basis-full sm:basis-auto sm:flex-1 sm:ml-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value) void save(value);
          }}
        >
          <input
            type="password"
            autoComplete="off"
            class="hud-input py-1! text-[12px]! font-mono flex-1 min-w-0"
            placeholder={props.set ? 'New value (replaces current)' : 'Value'}
            aria-label={`Value for ${props.name}`}
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
            ref={(el) => el?.focus()}
          />
          <Btn size="xs" type="submit" variant="primary" disabled={!value} loading={busy}>
            Save
          </Btn>
          <Btn size="xs" variant="ghost" type="button" onClick={() => setEditing(false)}>
            Cancel
          </Btn>
        </form>
      ) : (
        <span class="ml-auto flex gap-1.5">
          <Btn size="xs" onClick={() => setEditing(true)}>
            {props.set ? 'Replace' : 'Set'}
          </Btn>
          {props.set && (
            <Btn size="xs" variant="ghost" onClick={() => void save('')} loading={busy} title="Clear this secret">
              Clear
            </Btn>
          )}
        </span>
      )}
    </div>
  );
}

/** the test endpoint takes the extension-local tool name; fall back to the full name if the core wants that */
function testNames(extId: string, full: string): string[] {
  const prefix = `${extId.replace(/-/g, '_')}_`;
  return full.startsWith(prefix) ? [full.slice(prefix.length), full] : [full];
}

function ToolRow(props: { extId: string; tool: ExtensionToolInfo; disabled: boolean }) {
  const { tool } = props;
  const [open, setOpen] = useState(false);
  const [args, setArgs] = useState('{\n  \n}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; output: string; durationMs: number } | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  const run = async () => {
    let parsed: unknown = {};
    try {
      parsed = args.trim() ? JSON.parse(args) : {};
    } catch (e) {
      setParseErr(`Invalid JSON: ${errMsg(e)}`);
      return;
    }
    setParseErr(null);
    setBusy(true);
    setResult(null);
    try {
      let last: unknown;
      for (const n of testNames(props.extId, tool.name)) {
        try {
          const r = await api.post<{ ok: boolean; output: string; durationMs: number }>(`/extensions/${encodeURIComponent(props.extId)}/tools/${encodeURIComponent(n)}/test`, { args: parsed });
          setResult(r);
          return;
        } catch (e) {
          last = e;
          if (!(e instanceof ApiError && e.status === 404)) break;
        }
      }
      setResult({ ok: false, output: errMsg(last), durationMs: 0 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={`border ${open ? 'border-fg-3/60' : 'border-line'}`}>
      <div class="flex items-start gap-3 px-3 py-2">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-mono text-[12px] text-fg break-all">{tool.name}</span>
            <RiskTag risk={tool.risk} />
          </div>
          {tool.description && <div class="text-[12px] text-fg-3 mt-1 leading-snug">{tool.description}</div>}
        </div>
        <Btn size="xs" variant={open ? 'outline' : 'ghost'} onClick={() => setOpen(!open)} aria-expanded={open} title="Call this tool with test arguments">
          <FlaskConical size={11} /> Test
        </Btn>
      </div>
      {open && (
        <div class="border-t border-line px-3 py-3 flex flex-col gap-2 bg-[#121213]/40">
          <label class="hud-label text-[10px]" for={`args-${tool.name}`}>
            Arguments · JSON
          </label>
          <textarea
            id={`args-${tool.name}`}
            class={`${CODE_AREA} min-h-[84px]`}
            rows={4}
            spellcheck={false}
            value={args}
            onInput={(e) => setArgs((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void run();
              } else tabIndentHandler(e, setArgs);
            }}
          />
          {parseErr && <div class="font-mono text-[11px] text-red">{parseErr}</div>}
          <div class="flex items-center gap-2">
            <Btn size="xs" variant="primary" onClick={() => void run()} loading={busy} disabled={props.disabled}>
              {!busy && <Play size={10} />} Run
            </Btn>
            <span class="font-mono text-[10px] text-fg-3">{props.disabled ? 'extension must be active' : tool.risk !== 'safe' ? `runs for real · ${tool.risk}` : 'Ctrl+Enter'}</span>
            {result && (
              <span class="ml-auto font-mono text-[10px] tracking-[0.1em] uppercase flex items-center gap-1.5">
                <span class={result.ok ? 'text-fg-2' : 'text-red'}>{result.ok ? 'ok' : 'failed'}</span>
                {result.durationMs > 0 && <span class="text-fg-3">{result.durationMs} ms</span>}
              </span>
            )}
          </div>
          {result && (
            <pre class={`font-mono text-[11.5px] leading-relaxed max-h-[280px] overflow-auto whitespace-pre-wrap break-words border px-3 py-2 ${result.ok ? 'border-line text-fg-2' : 'border-red/40 text-fg'}`}>
              {result.output || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── panels ───────────────────────── */

export function ExtPanels(props: { d: ExtensionDetail }) {
  const { d } = props;
  if (!d.panels.length) return <EvoNote label="No panels" sub="Extensions can render small status panels — markdown, stat grids or item lists — that appear here." />;
  return (
    <div class="p-4 grid grid-cols-1 2xl:grid-cols-2 gap-3">
      {d.panels.map((p) => (
        <ExtPanelView key={p.id} extId={d.id} panelId={p.id} title={p.title} active={d.status === 'active'} />
      ))}
    </div>
  );
}

function ExtPanelView(props: { extId: string; panelId: string; title: string; active: boolean }) {
  const res = useResource<PanelContent>(props.active ? `/extensions/${encodeURIComponent(props.extId)}/panels/${encodeURIComponent(props.panelId)}` : null, ['extensions']);
  const c = res.data;
  return (
    <section class="border border-line bg-[#121213]/40 min-w-0">
      <header class="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span class="font-mono text-[11px] tracking-[0.14em] uppercase text-fg truncate">{c?.title || props.title}</span>
        <span class="ml-auto font-mono text-[10px] text-fg-3">{c ? ago(c.updatedAt) : ''}</span>
        <button class="text-fg-3 hover:text-fg disabled:opacity-40" onClick={() => void res.reload()} disabled={!props.active || res.loading} aria-label={`Refresh ${props.title}`} title="Refresh">
          {res.loading && c ? <Spinner /> : <RefreshCw size={12} />}
        </button>
      </header>
      <div class="p-3">
        {!props.active ? (
          <EvoNote class="py-6!" label="Extension not active" />
        ) : (
          <EvoGate res={res} loadingLabel="Rendering">
            {(c) => <PanelBody c={c} />}
          </EvoGate>
        )}
      </div>
    </section>
  );
}

export function PanelBody(props: { c: PanelContent }) {
  const { c } = props;
  const empty = !c.markdown && !c.stats?.length && !c.items?.length;
  return (
    <div class="flex flex-col gap-3">
      {c.stats && c.stats.length > 0 && (
        <div class="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-px bg-line border border-line">
          {c.stats.map((s, i) => (
            <div key={i} class="bg-surface px-3 py-2 min-w-0" title={s.hint}>
              <div class="hud-label text-[10px] truncate">{s.label}</div>
              <div class="hud-value text-[16px] font-light mt-0.5 truncate">{s.value}</div>
              {s.hint && <div class="font-mono text-[10px] text-fg-3 truncate">{s.hint}</div>}
            </div>
          ))}
        </div>
      )}
      {c.markdown && <Markdown text={c.markdown} class="text-[13px]!" />}
      {c.items && c.items.length > 0 && (
        <ul class="divide-y divide-line border-y border-line">
          {c.items.map((it, i) => {
            const body = (
              <>
                <span class="flex-1 min-w-0">
                  <span class="block text-[13px] text-fg truncate">{it.title}</span>
                  {it.sub && <span class="block text-[11.5px] text-fg-3 truncate mt-0.5">{it.sub}</span>}
                </span>
                {it.href && <ExternalLink size={11} class="text-fg-3 shrink-0" />}
              </>
            );
            return (
              <li key={i}>
                {it.href && /^https?:/i.test(it.href) ? (
                  <a
                    href={it.href}
                    class="flex items-center gap-2 py-1.5 px-1 hover:bg-white/[0.02]"
                    onClick={(e) => {
                      e.preventDefault();
                      void openExternal(it.href!);
                    }}
                  >
                    {body}
                  </a>
                ) : (
                  <div class="flex items-center gap-2 py-1.5 px-1">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {empty && <div class="font-mono text-[10px] tracking-[0.14em] uppercase text-fg-3 text-center py-3">Empty panel</div>}
    </div>
  );
}

/* ───────────────────────── logs ───────────────────────── */

export function ExtLogs(props: { d: ExtensionDetail }) {
  const logs = props.d.logs;
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all');
  const shown = logs.filter((l) => level === 'all' || (level === 'warn' ? l.level !== 'info' : l.level === 'error'));
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs.length, follow, level]);
  return (
    <div class="flex flex-col h-full min-h-[320px]">
      <div class="flex items-center gap-2 px-4 py-2 border-b border-line flex-wrap">
        <span class="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3">
          <span class="inline-block w-1.5 h-1.5 bg-fg-2 hud-blink" /> live · 3s
        </span>
        <div class="ml-auto flex items-center gap-1" role="group" aria-label="Log level">
          {(['all', 'warn', 'error'] as const).map((l) => (
            <button
              key={l}
              class={`font-mono text-[10px] tracking-[0.12em] uppercase px-2 py-0.5 border ${level === l ? 'border-fg-3 text-fg bg-subtle' : 'border-line text-fg-3 hover:text-fg-2'}`}
              aria-pressed={level === l}
              onClick={() => setLevel(l)}
            >
              {l}
            </button>
          ))}
          <label class="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 ml-2 cursor-pointer">
            <input type="checkbox" class="checkbox checkbox-xs rounded-[2px] border-line" checked={follow} onChange={(e) => setFollow((e.target as HTMLInputElement).checked)} />
            follow
          </label>
        </div>
      </div>
      <div ref={box} class="flex-1 min-h-0 overflow-auto bg-[#121213]/60 font-mono text-[11.5px] leading-[1.65] px-4 py-2" role="log" aria-live="off">
        {shown.length ? (
          shown.map((l, i) => (
            <div key={i} class="flex gap-3 min-w-0">
              <span class="text-fg-3 shrink-0 tabular-nums">{fmt.timeSec(l.ts)}</span>
              <span class={`shrink-0 w-10 uppercase text-[10px] pt-[2px] ${l.level === 'error' ? 'text-red' : l.level === 'warn' ? 'text-warning' : 'text-fg-3'}`}>{l.level}</span>
              <span class={`whitespace-pre-wrap break-words min-w-0 ${l.level === 'error' ? 'text-fg' : 'text-fg-2'}`}>{l.text}</span>
            </div>
          ))
        ) : (
          <div class="text-fg-3 py-8 text-center text-[10px] tracking-[0.16em] uppercase">No log lines{level !== 'all' ? ` at ${level}` : ''}</div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── history ───────────────────────── */

export function ExtHistory(props: { d: ExtensionDetail; onChanged: () => Promise<void> }) {
  const { d } = props;
  const [busy, setBusy] = useState<number | null>(null);
  const [confirmEl, confirm] = useConfirm();
  const hist = [...d.history].sort((a, b) => b.revision - a.revision);
  const rollback = async (rev: number) => {
    const ok = await confirm({
      title: `Roll back to revision ${rev}?`,
      body: <>The manifest and source of revision {rev} become the current version (recorded as a new revision) and the extension is reloaded.</>,
      confirmLabel: 'Roll back',
    });
    if (!ok) return;
    setBusy(rev);
    try {
      await api.post(`/extensions/${encodeURIComponent(d.id)}/rollback`, { revision: rev });
      toast(`Rolled back to revision ${rev}`, 'success');
      await props.onChanged();
    } catch (e) {
      toast(`Rollback failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  if (!hist.length) return <EvoNote label="No revisions recorded" />;
  return (
    <div class="p-4">
      <ol class="relative border-l border-line ml-1.5">
        {hist.map((h) => {
          const current = h.revision === d.revision;
          return (
            <li key={h.revision} class="relative pl-5 pb-4 last:pb-0">
              <span class={`absolute -left-[4px] top-1.5 w-[7px] h-[7px] ${current ? 'bg-red' : 'bg-surface border border-fg-3'}`} />
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-[12px] text-fg">rev {h.revision}</span>
                <Tag tone="plain">{h.actor}</Tag>
                {current && (
                  <span class="font-mono text-[10px] tracking-[0.12em] uppercase text-fg-2 flex items-center gap-1">
                    <Check size={10} /> current
                  </span>
                )}
                <span class="font-mono text-[10px] text-fg-3" title={stamp(h.ts)}>
                  {ago(h.ts)}
                </span>
                {!current && (
                  <Btn size="xs" variant="ghost" class="ml-auto" onClick={() => void rollback(h.revision)} loading={busy === h.revision} disabled={busy !== null}>
                    {busy !== h.revision && <Undo2 size={11} />} Rollback
                  </Btn>
                )}
              </div>
              {h.note && <div class="text-[12.5px] text-fg-2 mt-1 leading-relaxed">{h.note}</div>}
            </li>
          );
        })}
      </ol>
      {confirmEl}
    </div>
  );
}

