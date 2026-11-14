/** Evolve header strip: evolution stats, "Reflect now" and the Forge command input. */
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { EvolutionStats } from '@monarch/shared';
import { Hammer, RefreshCcw, CornerDownLeft } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { conn, settings, toast, type Resource } from '../../lib/store.ts';
import { Btn, Spinner } from '../ui.tsx';
import { ago, errMsg, isMissing, openSession } from './common.tsx';

export function EvolveHeader(props: { stats: Resource<EvolutionStats> }) {
  const st = props.stats.data;
  const missing = !st && isMissing(props.stats.error);
  const evo = settings.value?.evolution;
  const [reflecting, setReflecting] = useState(false);

  const reflect = async () => {
    setReflecting(true);
    try {
      const r = await api.post<{ sessionId: string }>('/evolution/reflect');
      toast('Reflection started', 'success');
      openSession(r?.sessionId);
    } catch (e) {
      toast(`Reflection failed: ${errMsg(e)}`, 'error');
    } finally {
      setReflecting(false);
    }
  };

  return (
    <section class="hud-panel shrink-0" aria-label="Evolution status">
      <div class="flex flex-col xl:flex-row xl:items-stretch">
        {/* title block */}
        <div class="flex items-center gap-3 px-4 py-3 xl:border-r border-b xl:border-b-0 border-line xl:w-[184px] 2xl:w-[220px] shrink-0">
          <span class="hud-code">EVO.00</span>
          <div class="min-w-0">
            <h1 class="font-mono text-[13px] tracking-[0.2em] uppercase text-fg">Evolve</h1>
            <div class="font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 mt-0.5 truncate">
              {evo ? (evo.enabled ? 'self-mod · on' : 'self-mod · off') : 'self-extension'}
            </div>
          </div>
          {evo && <span class={`ml-auto xl:hidden 2xl:inline-block 2xl:ml-0 inline-block w-1.5 h-1.5 ${evo.enabled ? 'bg-red' : 'border border-fg-3'}`} title={evo.enabled ? 'Evolution enabled' : 'Evolution disabled'} />}
        </div>

        {/* stats */}
        <div class="flex-1 min-w-0 grid grid-cols-3 lg:grid-cols-6 gap-px bg-line border-b xl:border-b-0 border-line">
          {missing ? (
            <div class="col-span-full bg-surface flex items-center gap-2 px-4 py-3 font-mono text-[10px] tracking-[0.14em] uppercase text-fg-3">
              <span class="inline-block w-1.5 h-1.5 border border-fg-3" /> Evolution service unavailable
            </div>
          ) : (
            <>
              <Cell label="Extensions">
                {st ? (
                  <>
                    <span class="text-fg">{st.extensions.active}</span>
                    <span class="text-fg-3">/{st.extensions.total}</span>
                    {st.extensions.error > 0 && <span class="text-red text-[11px] ml-2">{st.extensions.error} err</span>}
                  </>
                ) : (
                  <Dash loading={props.stats.loading} />
                )}
              </Cell>
              <Cell label="Skills">{st ? st.skills : <Dash loading={props.stats.loading} />}</Cell>
              <Cell label="Proposals">
                {st ? <span class={st.openProposals > 0 ? 'text-fg' : 'text-fg-2'}>{st.openProposals}<span class="text-fg-3 text-[11px] ml-1">open</span></span> : <Dash loading={props.stats.loading} />}
              </Cell>
              <Cell label="Changes · 7d" sub={st ? `reflected ${ago(st.lastReflectionAt)}` : undefined}>
                {st ? st.changes7d : <Dash loading={props.stats.loading} />}
              </Cell>
              <Cell label="Tools" class="col-span-2">
                {st ? <ToolSplit always={st.tools.always} deferred={st.tools.deferred} /> : <Dash loading={props.stats.loading} />}
              </Cell>
            </>
          )}
        </div>

        {/* actions */}
        <div class="flex flex-col gap-2 px-3 py-3 xl:w-[360px] 2xl:w-[460px] shrink-0 xl:border-l border-line">
          <ForgeInput />
          <div class="flex items-center gap-2">
            <Btn size="xs" onClick={() => void reflect()} loading={reflecting} disabled={conn.value !== 'open' || missing} title="Review recent sessions for friction and turn it into proposals">
              {!reflecting && <RefreshCcw size={11} />} Reflect now
            </Btn>
            <span class="font-mono text-[10px] tracking-[0.1em] uppercase text-fg-3 truncate">
              {evo ? `auto · ${evo.reflect}` : ''}
              {evo && !evo.autoEnable ? ' · review before enable' : ''}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Cell(props: { label: string; children: ComponentChildren; sub?: string; class?: string }) {
  return (
    <div class={`bg-surface px-3 2xl:px-4 py-2.5 sm:py-3 min-w-0 ${props.class ?? ''}`}>
      <div class="hud-label text-[10px]">{props.label}</div>
      <div class="hud-value text-[16px] sm:text-[18px] font-light leading-tight mt-1 truncate">{props.children}</div>
      {props.sub && <div class="font-mono text-[10px] text-fg-3 mt-0.5 truncate">{props.sub}</div>}
    </div>
  );
}

function Dash(props: { loading: boolean }) {
  return props.loading ? <Spinner /> : <span class="text-fg-3">—</span>;
}

/** "12 loaded · 48 on demand" with a thin proportional bar */
export function ToolSplit(props: { always: number; deferred: number }) {
  const total = props.always + props.deferred;
  const pct = total ? (props.always / total) * 100 : 0;
  return (
    <div class="min-w-0">
      <div class="text-[13px] leading-tight truncate pt-1">
        <span class="text-fg">{props.always}</span>
        <span class="text-fg-3"> loaded · </span>
        <span class="text-fg-2">{props.deferred}</span>
        <span class="text-fg-3"> on demand</span>
      </div>
      <div class="flex h-[3px] mt-2 bg-subtle" role="img" aria-label={`${props.always} tools always loaded, ${props.deferred} discovered on demand`}>
        <span class="h-full bg-fg-2" style={{ width: `${pct}%` }} />
        <span class="h-full w-px bg-[#121213]" />
      </div>
    </div>
  );
}

function ForgeInput() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ sessionId: string }>('/evolution/forge', { text: t });
      setText('');
      toast('Forging — follow along in Comms', 'success');
      openSession(r?.sessionId);
    } catch (e) {
      toast(`Forge failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="flex items-stretch border border-line bg-[#121213] focus-within:border-fg-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <span class="flex items-center pl-2.5 pr-1 text-red" aria-hidden="true">
        <Hammer size={13} strokeWidth={1.5} />
      </span>
      <input
        ref={ref}
        id="evolve-forge"
        class="flex-1 min-w-0 bg-transparent px-2 py-2 text-[13px] text-fg outline-none"
        placeholder="Describe a capability for Monarch to build…"
        aria-label="Forge: describe a capability for Monarch to build"
        value={text}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setText('');
            ref.current?.blur();
          }
        }}
        disabled={busy}
      />
      <button
        type="submit"
        class="flex items-center gap-1.5 px-3 font-mono text-[10px] tracking-[0.14em] uppercase text-fg-2 border-l border-line hover:text-fg hover:bg-subtle disabled:opacity-40"
        disabled={!text.trim() || busy || conn.value !== 'open'}
        title="Start a build session (Enter)"
      >
        {busy ? <Spinner /> : <CornerDownLeft size={11} />} Forge
      </button>
    </form>
  );
}
