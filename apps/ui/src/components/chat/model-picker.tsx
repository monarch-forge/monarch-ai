/**
 * Per-session model picker: lists every model of every configured provider
 * (Claude subscription, pi providers with credentials, custom local models).
 *
 * Value semantics (what `chat.send` expects):
 *  - claude-sdk: `model` is the model id or alias ("opus", "claude-sonnet-5-5")
 *  - pi:         `model` is "<provider>/<model-id>"
 * `null` means "use the default from Config".
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Check, ChevronUp, Search } from 'lucide-preact';
import type { EngineId, ModelInfo, ProviderStatus } from '@monarch/shared';
import { settings, useResource } from '../../lib/store.ts';

export interface ModelChoice {
  engine: EngineId;
  model: string;
}

export function choiceOf(m: ModelInfo): ModelChoice {
  return { engine: m.engine, model: m.engine === 'pi' ? `${m.provider}/${m.id}` : m.id };
}

function matches(m: ModelInfo, c: ModelChoice | null | undefined): boolean {
  if (!c || c.engine !== m.engine) return false;
  if (m.engine === 'pi') return c.model === `${m.provider}/${m.id}` || c.model === m.id;
  return c.model === m.id;
}

/** default engine/model from Config, in picker form */
export function defaultChoice(): ModelChoice | null {
  const s = settings.value;
  if (!s) return null;
  return s.engine === 'pi' ? { engine: 'pi', model: `${s.pi.provider}/${s.pi.model}` } : { engine: 'claude-sdk', model: s.claudeSdk.model };
}

interface Group {
  key: string;
  label: string;
  engine: EngineId;
  models: ModelInfo[];
}

export function ModelPicker(props: {
  /** explicit choice, or null for "default" */
  value: ModelChoice | null;
  onChange: (v: ModelChoice | null) => void;
  /** existing sessions can only switch models within their engine */
  lockEngine?: EngineId;
  /** shown when value is null (e.g. the open session's current model) */
  current?: ModelChoice | null;
  /** hide the "Default" entry (existing sessions) */
  noDefault?: boolean;
  class?: string;
  /** where the menu opens (default up: composers sit at the bottom) */
  placement?: 'up' | 'down';
  /** replaces the default trigger label */
  renderLabel?: (info: ModelInfo | undefined, choice: ModelChoice | null) => ComponentChildren;
  /** extra content before the label (e.g. a status dot) */
  leading?: ComponentChildren;
  buttonClass?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const models = useResource<ModelInfo[]>(open || props.value || props.current ? '/models/available' : null, ['providers', 'settings']);
  const providers = useResource<ProviderStatus[]>(open ? '/providers' : null, ['providers']);

  useEffect(() => {
    if (!open) return;
    setQ('');
    window.setTimeout(() => searchRef.current?.focus(), 0);
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups = useMemo<Group[]>(() => {
    const names = new Map((providers.data ?? []).map((p) => [p.id, p.name]));
    const term = q.trim().toLowerCase();
    const map = new Map<string, Group>();
    for (const m of models.data ?? []) {
      if (term && !`${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(term)) continue;
      const key = m.engine === 'claude-sdk' ? 'claude-sdk' : `pi:${m.provider}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          engine: m.engine,
          label: m.engine === 'claude-sdk' ? 'Claude · subscription' : `${names.get(m.provider) ?? m.provider} · pi`,
          models: [],
        });
      }
      map.get(key)!.models.push(m);
    }
    return [...map.values()].sort((a, b) => (a.engine === b.engine ? a.label.localeCompare(b.label) : a.engine === 'claude-sdk' ? -1 : 1));
  }, [models.data, providers.data, q]);

  const shown = props.value ?? props.current ?? null;
  const shownInfo = (models.data ?? []).find((m) => matches(m, shown));
  const def = defaultChoice();
  const label = props.value
    ? (shownInfo?.name ?? props.value.model)
    : props.current
      ? (shownInfo?.name ?? props.current.model)
      : `Default · ${def ? def.model : '—'}`;

  const pick = (v: ModelChoice | null) => {
    props.onChange(v);
    setOpen(false);
  };

  return (
    <div ref={rootRef} class={`relative ${props.class ?? ''}`}>
      <button
        type="button"
        class={`flex items-center gap-1.5 max-w-[240px] h-7 px-2 border font-mono text-[10.5px] tracking-[0.06em] transition-colors ${
          open ? 'border-fg-3 text-fg' : 'border-line text-fg-2 hover:text-fg hover:border-fg-3'
        } ${props.buttonClass ?? ''}`}
        onClick={() => setOpen(!open)}
        title={props.title ?? 'Model for this session'}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {props.leading ?? <span class={`inline-block w-1.5 h-1.5 shrink-0 ${props.value ? 'bg-red' : 'bg-fg-3'}`} />}
        <span class="truncate">{props.renderLabel ? props.renderLabel(shownInfo, shown) : label}</span>
        <ChevronUp size={11} strokeWidth={1.75} class={`shrink-0 transition-transform ${(props.placement === 'down') !== open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div class={`absolute ${props.placement === 'down' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'} right-0 z-50 w-[340px] max-w-[80vw] border border-line bg-surface shadow-[0_8px_24px_rgb(0_0_0/0.45)] flex flex-col`}>
          <label class="flex items-center gap-2 px-2.5 border-b border-line">
            <Search size={12} strokeWidth={1.75} class="text-fg-3 shrink-0" />
            <input
              ref={searchRef}
              class="flex-1 min-w-0 bg-transparent py-2 text-[12px] text-fg outline-none placeholder:text-fg-3"
              placeholder="Search models…"
              value={q}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            />
          </label>
          <div class="max-h-[320px] overflow-y-auto py-1" role="listbox">
            {!props.noDefault && !q && (
              <Row selected={!props.value} onClick={() => pick(null)} name={`Default`} sub={def ? `${def.engine === 'pi' ? 'pi' : 'claude'} · ${def.model} — set in Config` : 'set in Config'} />
            )}
            {models.loading && !models.data && <div class="px-3 py-3 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3">Loading models…</div>}
            {models.error && <div class="px-3 py-3 font-mono text-[11px] text-red">{models.error}</div>}
            {models.data && !groups.length && (
              <div class="px-3 py-3 text-[12px] text-fg-3">{q ? 'No matching models.' : 'No configured providers. Add one in Config → Providers.'}</div>
            )}
            {groups.map((g) => {
              const locked = !!props.lockEngine && g.engine !== props.lockEngine;
              return (
                <div key={g.key} class="py-1">
                  <div class="flex items-center justify-between px-3 pt-1.5 pb-1 font-mono text-[9.5px] tracking-[0.16em] uppercase text-fg-3">
                    <span>{g.label}</span>
                    {locked && <span class="normal-case tracking-normal">new session only</span>}
                  </div>
                  {g.models.map((m) => (
                    <Row
                      key={`${g.key}/${m.id}`}
                      selected={matches(m, shown)}
                      disabled={locked}
                      onClick={() => pick(choiceOf(m))}
                      name={m.name}
                      sub={[m.id !== m.name ? m.id : null, m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K ctx` : null, m.reasoning ? 'reasoning' : null]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  ))}
                </div>
              );
            })}
          </div>
          {props.placement === 'down' && !props.lockEngine && (
            <div class="px-3 py-1.5 border-t border-line text-[10.5px] text-fg-3">
              Default for new sessions. Open sessions keep their own model.
            </div>
          )}
          {props.lockEngine && (
            <div class="px-3 py-1.5 border-t border-line text-[10.5px] text-fg-3">
              Switching applies from your next message. Other engines need a new session.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row(props: { name: string; sub?: string; selected: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.selected}
      disabled={props.disabled}
      class={`w-full flex items-center gap-2 px-3 py-1.5 text-left border-l-2 ${
        props.selected ? 'border-red bg-subtle' : 'border-transparent'
      } ${props.disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/[0.03]'}`}
      onClick={props.onClick}
    >
      <span class="flex-1 min-w-0">
        <span class="block truncate text-[12.5px] text-fg">{props.name}</span>
        {props.sub && <span class="block truncate font-mono text-[10px] text-fg-3">{props.sub}</span>}
      </span>
      {props.selected && <Check size={12} strokeWidth={2} class="text-red shrink-0" />}
    </button>
  );
}
