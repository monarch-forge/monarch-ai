/** Evolve → Extensions: list (left) + detail (right); stacks at narrow widths. Route: #/evolve/extensions/:id? ("new" = editor). */
import { useMemo, useState } from 'preact/hooks';
import type { ExtensionDetail, ExtensionSummary } from '@monarch/shared';
import { ArrowLeft, Plus, Power, RotateCw, Search, Trash2, Pencil } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { navigate, toast, useResource } from '../../lib/store.ts';
import { Btn, Panel, Tag, fmt } from '../ui.tsx';
import { useConfirm } from '../mail/kit.tsx';
import { EvoGate, EvoNote, OriginTag, StatusDot, StatusTag, errMsg } from './common.tsx';
import { ExtOverview, ExtPanels, ExtLogs, ExtHistory } from './ext-sections.tsx';
import { ExtSource, NewExtension } from './ext-editor.tsx';

const SUB = ['overview', 'panels', 'source', 'logs', 'history'] as const;
type Sub = (typeof SUB)[number];

export function ExtensionsTab(props: { id?: string; sub?: string }) {
  const list = useResource<ExtensionSummary[]>('/extensions', ['extensions']);
  const [q, setQ] = useState('');
  const items = useMemo(() => {
    const all = list.data ?? [];
    const t = q.trim().toLowerCase();
    const f = t ? all.filter((x) => `${x.name} ${x.id} ${x.description}`.toLowerCase().includes(t)) : all;
    const rank = { error: 0, starting: 1, active: 2, disabled: 3 } as const;
    return [...f].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.name.localeCompare(b.name));
  }, [list.data, q]);
  const selected = props.id;

  return (
    <div class="h-full min-h-0 grid gap-3 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)]">
      <Panel
        code="EVO.11"
        title="Extensions"
        noPad
        bodyClass="flex flex-col"
        class={`min-h-0 ${selected ? 'hidden lg:flex' : ''}`}
        right={
          <>
            {list.data && <Tag tone="plain">{list.data.length}</Tag>}
            <Btn size="xs" variant="ghost" onClick={() => navigate('evolve/extensions/new')} title="Write a new extension">
              <Plus size={12} /> New
            </Btn>
          </>
        }
      >
        {(list.data?.length ?? 0) > 5 && (
          <div class="px-3 py-2 border-b border-line">
            <label class="relative block">
              <Search size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
              <input class="hud-input py-1.5! pl-7! text-[13px]!" placeholder="Filter extensions…" aria-label="Filter extensions" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </label>
          </div>
        )}
        <div class="flex-1 min-h-0 overflow-y-auto py-1">
          <EvoGate res={list} loadingLabel="Loading extensions">
            {() =>
              items.length ? (
                <ul role="list">
                  {items.map((x) => (
                    <li key={x.id}>
                      <ExtRow x={x} active={x.id === selected} />
                    </li>
                  ))}
                </ul>
              ) : q ? (
                <EvoNote label="No match" />
              ) : (
                <EvoNote
                  icon
                  label="No extensions yet"
                  sub="Extensions add tools, panels and background jobs. Ask Monarch to forge one above, or write your own."
                  action={
                    <Btn size="xs" onClick={() => navigate('evolve/extensions/new')}>
                      <Plus size={11} /> New extension
                    </Btn>
                  }
                />
              )
            }
          </EvoGate>
        </div>
      </Panel>

      <div class={`min-h-0 ${selected ? 'flex' : 'hidden lg:flex'} flex-col`}>
        {selected === 'new' ? (
          <NewExtension />
        ) : selected ? (
          <ExtDetailPane key={selected} id={selected} sub={(SUB as readonly string[]).includes(props.sub ?? '') ? (props.sub as Sub) : 'overview'} />
        ) : (
          <Panel code="EVO.12" title="Detail" class="flex-1">
            <EvoNote label="Select an extension" sub="Inspect its manifest, tools, panels, source and history." />
          </Panel>
        )}
      </div>
    </div>
  );
}

function ExtRow(props: { x: ExtensionSummary; active: boolean }) {
  const { x } = props;
  return (
    <a href={`#/evolve/extensions/${encodeURIComponent(x.id)}`} class="hud-row !items-start !py-2.5 focus-visible:outline-1 focus-visible:outline-fg-3" data-active={props.active ? 'true' : 'false'} aria-current={props.active ? 'true' : undefined}>
      <StatusDot status={x.status} class="mt-1.5" />
      <span class="flex-1 min-w-0">
        <span class="flex items-center gap-2">
          <span class={`truncate text-[13px] ${x.enabled ? 'text-fg' : 'text-fg-2'}`}>{x.name}</span>
          <span class="font-mono text-[10px] text-fg-3 shrink-0">v{x.version}</span>
        </span>
        <span class="block text-[11.5px] text-fg-3 truncate mt-0.5">{x.status === 'error' && x.error ? <span class="text-red">{x.error}</span> : x.description || x.id}</span>
        <span class="flex items-center gap-3 mt-1.5 font-mono text-[10px] tracking-[0.08em] uppercase text-fg-3">
          <span>{x.origin}</span>
          <span>{x.tools.length} tool{x.tools.length === 1 ? '' : 's'}</span>
          {x.panels.length > 0 && <span>{x.panels.length} panel{x.panels.length === 1 ? '' : 's'}</span>}
          <span class="ml-auto">{fmt.num(x.calls)} calls</span>
        </span>
      </span>
    </a>
  );
}

function ExtDetailPane(props: { id: string; sub: Sub }) {
  const pollLogs = props.sub === 'logs';
  const res = useResource<ExtensionDetail>(`/extensions/${encodeURIComponent(props.id)}`, ['extensions'], { intervalMs: pollLogs ? 3000 : undefined });
  const [busy, setBusy] = useState<null | 'toggle' | 'reload' | 'remove'>(null);
  const [confirmEl, confirm] = useConfirm();
  const d = res.data;
  const base = `evolve/extensions/${encodeURIComponent(props.id)}`;

  const act = async (kind: 'toggle' | 'reload' | 'remove') => {
    if (!d) return;
    if (kind === 'remove') {
      const ok = await confirm({
        title: `Remove ${d.name}?`,
        body: (
          <>
            The extension, its tools, panels and jobs are unloaded and its folder is deleted. Revision history for <span class="font-mono text-fg">{d.id}</span> is lost.
          </>
        ),
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(kind);
    try {
      const p = `/extensions/${encodeURIComponent(d.id)}`;
      if (kind === 'toggle') {
        await api.post(`${p}/toggle`, { enabled: !d.enabled });
        toast(`${d.name} ${d.enabled ? 'disabled' : 'enabled'}`, 'success');
      } else if (kind === 'reload') {
        await api.post(`${p}/reload`);
        toast(`${d.name} reloaded`, 'success');
      } else {
        await api.del(p);
        toast(`${d.name} removed`, 'success');
        navigate('evolve/extensions');
        return;
      }
      await res.reload();
    } catch (e) {
      toast(`${kind} failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      code="EVO.12"
      title={d?.name ?? props.id}
      class="flex-1"
      noPad
      bodyClass="flex flex-col"
      active={d?.status === 'error'}
      right={
        d && (
          <>
            <StatusTag status={d.status} />
            <OriginTag origin={d.origin} />
          </>
        )
      }
    >
      <EvoGate res={res} loadingLabel="Loading extension">
        {(d) => (
          <>
            {/* identity + actions */}
            <div class="px-4 pt-3 pb-3 border-b border-line">
              <div class="flex items-start gap-3 flex-wrap">
                <button class="lg:hidden text-fg-3 hover:text-fg mt-0.5" onClick={() => navigate('evolve/extensions')} aria-label="Back to extensions">
                  <ArrowLeft size={14} />
                </button>
                <div class="flex-1 min-w-[200px]">
                  <div class="flex items-baseline gap-2 flex-wrap">
                    <span class="font-mono text-[12px] text-fg-2">{d.id}</span>
                    <span class="font-mono text-[10px] text-fg-3">v{d.version} · rev {d.revision}</span>
                  </div>
                  {d.description && <p class="text-[13px] text-fg-2 mt-1 leading-relaxed">{d.description}</p>}
                </div>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <label class="flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-2 mr-1 cursor-pointer">
                    <input
                      type="checkbox"
                      class="toggle toggle-xs rounded-[2px] border-line checked:bg-red checked:border-red checked:text-fg"
                      checked={d.enabled}
                      disabled={busy !== null}
                      onChange={() => void act('toggle')}
                      aria-label={d.enabled ? 'Disable extension' : 'Enable extension'}
                    />
                    {d.enabled ? 'On' : 'Off'}
                  </label>
                  <Btn size="xs" onClick={() => void act('reload')} loading={busy === 'reload'} disabled={busy !== null || !d.enabled} title="Restart the extension process">
                    {busy !== 'reload' && <RotateCw size={11} />} Reload
                  </Btn>
                  <Btn size="xs" onClick={() => navigate(`${base}/source`)} title="Edit source">
                    <Pencil size={11} /> Edit
                  </Btn>
                  {d.origin !== 'builtin' && (
                    <Btn size="xs" variant="ghost" class="hover:text-red!" onClick={() => void act('remove')} loading={busy === 'remove'} disabled={busy !== null} title="Remove extension">
                      {busy !== 'remove' && <Trash2 size={11} />}
                    </Btn>
                  )}
                </div>
              </div>
              {d.status === 'error' && d.error && (
                <div class="mt-3 border border-red/40 bg-red/[0.05] px-3 py-2 font-mono text-[11.5px] text-fg whitespace-pre-wrap break-words">
                  <span class="text-red">ERROR · </span>
                  {d.error}
                </div>
              )}
              {!d.enabled && d.origin === 'agent' && d.history.length <= 1 && (
                <div class="mt-3 flex items-center gap-2 text-[12px] text-fg-2">
                  <Power size={12} class="text-fg-3" /> Written by Monarch and waiting for your review. Check the source and permissions, then switch it on.
                </div>
              )}
            </div>

            {/* sub-tabs */}
            <nav class="flex items-stretch border-b border-line overflow-x-auto [scrollbar-width:none] shrink-0" aria-label="Extension sections">
              {SUB.map((s) => {
                const count = s === 'panels' ? d.panels.length : s === 'history' ? d.history.length : s === 'logs' ? d.logs.length : undefined;
                return (
                  <a key={s} href={`#/${base}/${s}`} class="hud-nav !h-9 !px-3.5 shrink-0" aria-current={props.sub === s ? 'page' : undefined}>
                    {s}
                    {count !== undefined && count > 0 && <span class="text-fg-3 text-[10px]">{count}</span>}
                  </a>
                );
              })}
            </nav>

            <div class="flex-1 min-h-0 overflow-y-auto">
              {props.sub === 'overview' && <ExtOverview d={d} onChanged={res.reload} />}
              {props.sub === 'panels' && <ExtPanels d={d} />}
              {props.sub === 'source' && <ExtSource d={d} onSaved={res.reload} />}
              {props.sub === 'logs' && <ExtLogs d={d} />}
              {props.sub === 'history' && <ExtHistory d={d} onChanged={res.reload} />}
            </div>
            {confirmEl}
          </>
        )}
      </EvoGate>
      {!d && res.error && (
        <div class="px-4 pb-4 lg:hidden">
          <Btn size="xs" variant="ghost" onClick={() => navigate('evolve/extensions')}>
            <ArrowLeft size={11} /> Back
          </Btn>
        </div>
      )}
    </Panel>
  );
}

