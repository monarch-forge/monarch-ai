/** Evolve header strip: evolution stats, "Reflect now" and the Forge command input. */
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

  const attention: { label: string; href: string; tone: 'red' | 'warn' }[] = [];
  if (st?.extensions.error) attention.push({ label: `${st.extensions.error} extension${st.extensions.error > 1 ? 's' : ''} need a look`, href: '#/evolve/extensions', tone: 'red' });
  if (st?.openProposals) attention.push({ label: `${st.openProposals} proposal${st.openProposals > 1 ? 's' : ''} waiting`, href: '#/evolve/proposals', tone: 'warn' });

  return (
    <section class="shrink-0 flex flex-col gap-4" aria-label="Evolution status">
      <div class="flex flex-col lg:flex-row lg:items-start gap-4">
        <div class="flex-1 min-w-0">
          <h1 class="text-[20px] font-semibold text-fg flex items-center gap-2.5">
            Evolve
            {evo && (
              <span class="text-[12px] font-normal text-fg-3 flex items-center gap-1.5">
                <span class={`inline-block w-1.5 h-1.5 rounded-full ${evo.enabled ? 'bg-success' : 'bg-fg-3'}`} />
                {evo.enabled ? 'self-extension on' : 'self-extension off'}
              </span>
            )}
          </h1>
          <p class="text-[13.5px] text-fg-2 mt-1 leading-relaxed">
            {missing ? (
              'The evolution service is not available right now.'
            ) : st ? (
              <>
                Monarch has {st.extensions.active} active extension{st.extensions.active === 1 ? '' : 's'} and {st.skills} skill{st.skills === 1 ? '' : 's'}, with{' '}
                {st.changes7d} change{st.changes7d === 1 ? '' : 's'} this week. {st.lastReflectionAt ? `Last reflected ${ago(st.lastReflectionAt)}.` : 'No reflection yet.'}
              </>
            ) : props.stats.loading ? (
              <Spinner />
            ) : (
              '—'
            )}
          </p>
          <div class="flex flex-wrap gap-2 mt-3">
            {attention.length ? (
              attention.map((a) => (
                <a key={a.href} href={a.href} class={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] ${a.tone === 'red' ? 'bg-red/12 text-red' : 'bg-warning/12 text-warning'} hover:brightness-125`}>
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-current" /> {a.label}
                </a>
              ))
            ) : st ? (
              <span class="text-[12.5px] text-fg-3">Nothing waiting on you.</span>
            ) : null}
          </div>
        </div>

        <div class="flex flex-col gap-2 w-full lg:w-[420px] shrink-0">
          <ForgeInput />
          <div class="flex items-center gap-3">
            <Btn size="xs" variant="ghost" onClick={() => void reflect()} loading={reflecting} disabled={conn.value !== 'open' || missing} title="Review recent sessions for friction and turn it into proposals">
              {!reflecting && <RefreshCcw size={12} />} Reflect now
            </Btn>
            <span class="text-[12px] text-fg-3 truncate">
              {evo ? `Reflects ${evo.reflect}` : ''}
              {evo && !evo.autoEnable ? ' · you review before anything is enabled' : ''}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
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
      class="flex items-stretch border border-line bg-[#121213] rounded-[8px] overflow-hidden focus-within:border-fg-3 transition-colors"
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
        class="flex items-center gap-1.5 px-3 text-[12.5px] text-fg-2 hover:text-fg hover:bg-subtle disabled:opacity-40"
        disabled={!text.trim() || busy || conn.value !== 'open'}
        title="Start a build session (Enter)"
      >
        {busy ? <Spinner /> : <CornerDownLeft size={11} />} Forge
      </button>
    </form>
  );
}
