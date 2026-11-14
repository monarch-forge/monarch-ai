/** Evolve → Tools: the full tool catalog, grouped, with loading mode / risk / source. */
import { useMemo, useRef, useState } from 'preact/hooks';
import type { ToolCatalogEntry } from '@monarch/shared';
import { Search } from 'lucide-preact';
import { settings, useResource } from '../../lib/store.ts';
import { Panel, Tag } from '../ui.tsx';
import { useHotkeys } from '../mail/kit.tsx';
import { EvoGate, EvoNote, RiskTag } from './common.tsx';
import { ToolSplit } from './header.tsx';
import { Chip } from './timeline.tsx';

export function ToolsTab() {
  const res = useResource<ToolCatalogEntry[]>('/tools/catalog', ['extensions', 'settings']);
  const [q, setQ] = useState('');
  const [load, setLoad] = useState<'all' | 'always' | 'deferred'>('all');
  const [src, setSrc] = useState<'all' | 'core' | 'extension'>('all');
  const input = useRef<HTMLInputElement>(null);
  useHotkeys({ '/': () => input.current?.focus() });

  const all = res.data ?? [];
  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    const f = all.filter(
      (x) =>
        (load === 'all' || x.loading === load) &&
        (src === 'all' || x.source === src) &&
        (!t || `${x.name} ${x.description} ${x.group} ${x.extensionId ?? ''}`.toLowerCase().includes(t)),
    );
    const m = new Map<string, ToolCatalogEntry[]>();
    for (const x of f) {
      const g = x.group || 'other';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(x);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, items]) => ({ g, items: items.sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [all, q, load, src]);
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const always = all.filter((x) => x.loading === 'always').length;
  const defer = settings.value?.evolution?.deferTools;

  return (
    <Panel code="EVO.51" title="Tool catalog" class="h-full" noPad bodyClass="flex flex-col" right={res.data && <Tag tone="plain">{shown === all.length ? all.length : `${shown}/${all.length}`}</Tag>}>
      <div class="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap">
        <label class="relative w-full sm:w-64">
          <Search size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
          <input
            ref={input}
            class="hud-input py-1.5! pl-7! text-[13px]!"
            placeholder="Filter tools… ( / )"
            aria-label="Filter tools"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Escape' && (setQ(''), (e.target as HTMLInputElement).blur())}
          />
        </label>
        <div class="flex gap-1" role="group" aria-label="Loading mode">
          {(['all', 'always', 'deferred'] as const).map((l) => (
            <Chip key={l} on={load === l} onClick={() => setLoad(l)}>
              {l === 'all' ? 'Any load' : l}
            </Chip>
          ))}
        </div>
        <div class="flex gap-1" role="group" aria-label="Source">
          {(['all', 'core', 'extension'] as const).map((s) => (
            <Chip key={s} on={src === s} onClick={() => setSrc(s)}>
              {s === 'all' ? 'Any source' : s}
            </Chip>
          ))}
        </div>
        {res.data && (
          <div class="w-full lg:w-56 lg:ml-auto">
            <ToolSplit always={always} deferred={all.length - always} />
          </div>
        )}
      </div>
      {defer === false && <div class="px-4 py-1.5 border-b border-line text-[11.5px] text-fg-3">Deferred loading is off in Config — every tool is sent with every prompt.</div>}
      <div class="flex-1 min-h-0 overflow-y-auto">
        <EvoGate res={res} loadingLabel="Loading catalog">
          {() =>
            groups.length ? (
              <div class="p-3 grid grid-cols-1 2xl:grid-cols-2 gap-3 items-start">
                {groups.map(({ g, items }) => (
                  <section key={g} class="border border-line min-w-0">
                    <header class="flex items-center gap-2 px-3 py-1.5 border-b border-line bg-[#121213]/40">
                      <span class="font-mono text-[11px] tracking-[0.14em] uppercase text-fg">{g}</span>
                      <span class="font-mono text-[10px] text-fg-3">{items.length}</span>
                    </header>
                    <ul class="divide-y divide-line">
                      {items.map((t) => (
                        <li key={t.name} class="px-3 py-2 flex items-start gap-3">
                          <span
                            class={`inline-block w-1.5 h-1.5 mt-1.5 shrink-0 ${t.loading === 'always' ? 'bg-fg-2' : 'border border-fg-3'}`}
                            title={t.loading === 'always' ? 'Always loaded' : 'Deferred — found via tool search'}
                          />
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 flex-wrap">
                              <span class="font-mono text-[12px] text-fg break-all">{t.name}</span>
                              {t.risk !== 'safe' && <RiskTag risk={t.risk} />}
                            </div>
                            <div class="text-[12px] text-fg-3 mt-0.5 leading-snug line-clamp-2" title={t.description}>
                              {t.description}
                            </div>
                          </div>
                          <div class="flex flex-col items-end gap-1 shrink-0 font-mono text-[10px] tracking-[0.1em] uppercase">
                            <span class={t.loading === 'always' ? 'text-fg-2' : 'text-fg-3'}>{t.loading === 'always' ? 'always' : 'on demand'}</span>
                            {t.source === 'extension' ? (
                              <a href={`#/evolve/extensions/${encodeURIComponent(t.extensionId ?? '')}`} class="text-fg-3 hover:text-fg-2 normal-case tracking-normal max-w-[14ch] truncate" title={`From extension ${t.extensionId}`}>
                                ⌁ {t.extensionId}
                              </a>
                            ) : (
                              <span class="text-fg-3">core</span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <EvoNote label={all.length ? 'No tools match' : 'Catalog is empty'} />
            )
          }
        </EvoGate>
      </div>
    </Panel>
  );
}
