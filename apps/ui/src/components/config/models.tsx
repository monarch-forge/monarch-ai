/** Config → Models: engine choice, Claude Agent SDK options, pi provider/model + custom OpenAI-compatible models. */
import { useState } from 'preact/hooks';
import type { CustomModel, EngineId, ModelInfo, ProviderStatus, Settings, ThinkingLevel } from '@monarch/shared';
import { Plus, Trash2 } from 'lucide-preact';
import { qs } from '../../lib/api.ts';
import { settings, useResource } from '../../lib/store.ts';
import { Panel, Tag, Spinner, ErrorLine } from '../ui.tsx';
import { Field, INPUT, SELECT, RADIO, ToggleRow, SaveBar, saveSettings, useDraft, Kbd } from './fields.tsx';

type Slice = Pick<Settings, 'engine' | 'claudeSdk' | 'pi'>;

const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];
const EFFORTS: Settings['claudeSdk']['effort'][] = ['low', 'medium', 'high', 'max'];
const THINKING: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

function ModelSelect(props: { models: ModelInfo[] | undefined; loading: boolean; error?: string; value: string; onChange: (v: string) => void; extra?: string[] }) {
  const ids = new Set<string>();
  const opts: { id: string; label: string }[] = [];
  for (const id of props.extra ?? []) if (!ids.has(id)) ids.add(id), opts.push({ id, label: id });
  for (const m of props.models ?? []) if (!ids.has(m.id)) ids.add(m.id), opts.push({ id: m.id, label: m.name && m.name !== m.id ? `${m.name} — ${m.id}` : m.id });
  if (props.value && !ids.has(props.value)) opts.unshift({ id: props.value, label: `${props.value} (current)` });
  if (!opts.length) {
    return (
      <div class="flex flex-col gap-1">
        <input class={`${INPUT} font-mono`} value={props.value} onInput={(e) => props.onChange((e.target as HTMLInputElement).value)} placeholder="model id" spellcheck={false} />
        {props.loading ? <Spinner /> : props.error ? <div class="text-[11px] text-fg-3">Model list unavailable ({props.error}) — type an id.</div> : null}
      </div>
    );
  }
  const selected = props.models?.find((m) => m.id === props.value);
  return (
    <div class="flex flex-col gap-1">
      <select class={`${SELECT} font-mono`} value={props.value} onChange={(e) => props.onChange((e.target as HTMLSelectElement).value)}>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {selected && (
        <div class="font-mono text-[10.5px] text-fg-3 flex gap-3 flex-wrap">
          {selected.contextWindow ? <span>ctx {Math.round(selected.contextWindow / 1000)}K</span> : null}
          {selected.maxTokens ? <span>out {Math.round(selected.maxTokens / 1000)}K</span> : null}
          {selected.reasoning ? <span>reasoning</span> : null}
          {selected.input?.includes('image') ? <span>vision</span> : null}
          {selected.cost ? (
            <span>
              ${selected.cost.input}/${selected.cost.output} per M
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function EngineCard(props: { id: EngineId; current: EngineId; title: string; body: string; onPick: (e: EngineId) => void }) {
  const on = props.id === props.current;
  return (
    <label class={`flex-1 flex gap-3 border p-3 cursor-pointer ${on ? 'border-red/60 bg-red/[0.04]' : 'border-line hover:border-fg-3'}`}>
      <input type="radio" name="engine" class={`${RADIO} mt-0.5`} checked={on} onChange={() => props.onPick(props.id)} />
      <span>
        <span class="block font-mono text-[12px] tracking-[0.12em] uppercase text-fg">{props.title}</span>
        <span class="block text-[12px] text-fg-3 mt-1 leading-relaxed">{props.body}</span>
      </span>
    </label>
  );
}

export function ModelsSection() {
  const s = settings.value!;
  const [draft, set, dirty, reset] = useDraft<Slice>({ engine: s.engine, claudeSdk: s.claudeSdk, pi: s.pi });
  const [saving, setSaving] = useState(false);
  const providers = useResource<ProviderStatus[]>('/providers', ['providers', 'settings']);
  const claudeModels = useResource<ModelInfo[]>('/models?engine=claude-sdk', ['providers']);
  const piProvider = draft?.pi.provider ?? '';
  const piModels = useResource<ModelInfo[]>(piProvider ? `/models${qs({ engine: 'pi', provider: piProvider })}` : null, ['providers', 'settings']);
  if (!draft) return null;

  const c = draft.claudeSdk;
  const p = draft.pi;
  const setC = (x: Partial<Slice['claudeSdk']>) => set({ claudeSdk: { ...c, ...x } });
  const setP = (x: Partial<Slice['pi']>) => set({ pi: { ...p, ...x } });

  const claudeProv = providers.data?.find((x) => x.id === 'claude-sdk') ?? providers.data?.find((x) => x.source === 'claude-code');
  const piProviders = (providers.data ?? []).filter((x) => x.engine === 'pi');

  const save = async () => {
    setSaving(true);
    const pi = { ...draft.pi, customModels: draft.pi.customModels.filter((m) => m.id.trim() && (m.baseUrl.trim() || draft.pi.customBaseUrl?.trim())) };
    const ok = await saveSettings({ engine: draft.engine, claudeSdk: draft.claudeSdk, pi });
    setSaving(false);
    if (ok) reset();
  };

  return (
    <div class="flex flex-col gap-3">
      <Panel code="CFG.21" title="Default engine" right={<Tag tone="red">{draft.engine === 'pi' ? 'pi' : 'claude sdk'}</Tag>}>
        <div class="flex flex-col md:flex-row gap-3">
          <EngineCard
            id="claude-sdk"
            current={draft.engine}
            onPick={(e) => set({ engine: e })}
            title="Claude Agent SDK"
            body="Claude Code's agent loop and tools. Uses your Claude subscription (or an Anthropic API key). Best for coding and long tool-heavy tasks."
          />
          <EngineCard
            id="pi"
            current={draft.engine}
            onPick={(e) => set({ engine: e })}
            title="Pi"
            body="Provider-agnostic loop (Anthropic, OpenAI, Google, OpenRouter, Copilot, local Ollama / LM Studio…) with Monarch's own tools."
          />
        </div>
        <div class="text-[11.5px] text-fg-3 mt-3">Applies to new sessions. Workshop lets you pick an engine per coding session.</div>
      </Panel>

      <Panel
        code="CFG.22"
        title="Claude Agent SDK"
        active={draft.engine === 'claude-sdk'}
        right={
          providers.loading && !providers.data ? (
            <Spinner />
          ) : claudeProv?.configured ? (
            <Tag tone="ok">{claudeProv.source === 'claude-code' ? 'subscription' : claudeProv.source ?? 'ready'}</Tag>
          ) : (
            <Tag tone="warn">not signed in</Tag>
          )
        }
      >
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Model">
            <ModelSelect models={claudeModels.data} loading={claudeModels.loading} error={claudeModels.error} value={c.model} onChange={(v) => setC({ model: v })} extra={CLAUDE_ALIASES} />
          </Field>
          <Field label="Effort" hint="Reasoning budget per turn.">
            <select class={SELECT} value={c.effort} onChange={(e) => setC({ effort: (e.target as HTMLSelectElement).value as Slice['claudeSdk']['effort'] })}>
              {EFFORTS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Claude executable" hint="Absolute path to the `claude` CLI. Leave empty to auto-detect." class="md:col-span-2">
            <input class={`${INPUT} font-mono`} value={c.executablePath} onInput={(e) => setC({ executablePath: (e.target as HTMLInputElement).value })} placeholder="auto-detect" spellcheck={false} />
          </Field>
        </div>
        <div class="mt-3">
          <ToggleRow
            label="Use Claude subscription"
            hint="On: authenticate through your Claude Code login (Pro/Max). Off: use the Anthropic API key stored under Providers."
            checked={c.useSubscription}
            onChange={(v) => setC({ useSubscription: v })}
          />
        </div>
        <div class="mt-2 border border-line bg-[#121213] px-3 py-2.5 text-[12.5px]">
          {providers.error && !providers.data ? (
            <ErrorLine error={providers.error} />
          ) : claudeProv?.configured ? (
            <div class="flex items-center gap-3 flex-wrap">
              <span class="inline-block w-1.5 h-1.5 bg-success" />
              <span class="text-fg">Signed in</span>
              {claudeProv.account && <span class="font-mono text-[11.5px] text-fg-2">{claudeProv.account}</span>}
              {claudeProv.source && <span class="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">via {claudeProv.source}</span>}
            </div>
          ) : (
            <div class="text-fg-2 leading-relaxed">
              <div class="flex items-center gap-2 mb-1">
                <span class="inline-block w-1.5 h-1.5 bg-warning" />
                <span class="text-fg">No Claude Code login detected.</span>
              </div>
              Run <Kbd>claude auth login</Kbd> in a terminal, sign in with your Claude account, then come back — status refreshes automatically.
              {claudeProv?.error && <div class="font-mono text-[11px] text-fg-3 mt-1">{claudeProv.error}</div>}
            </div>
          )}
        </div>
      </Panel>

      <Panel code="CFG.23" title="Pi" active={draft.engine === 'pi'}>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Provider">
            {piProviders.length ? (
              <select class={SELECT} value={p.provider} onChange={(e) => setP({ provider: (e.target as HTMLSelectElement).value, model: '' })}>
                {!piProviders.some((x) => x.id === p.provider) && p.provider && <option value={p.provider}>{p.provider}</option>}
                {piProviders.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} {x.configured ? '' : '— not configured'}
                  </option>
                ))}
              </select>
            ) : (
              <input class={`${INPUT} font-mono`} value={p.provider} onInput={(e) => setP({ provider: (e.target as HTMLInputElement).value })} placeholder="anthropic" />
            )}
          </Field>
          <Field label="Model">
            <ModelSelect models={piModels.data} loading={piModels.loading} error={piModels.error} value={p.model} onChange={(v) => setP({ model: v })} />
          </Field>
          <Field label="Thinking">
            <select class={SELECT} value={p.thinkingLevel} onChange={(e) => setP({ thinkingLevel: (e.target as HTMLSelectElement).value as ThinkingLevel })}>
              {THINKING.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {piProviders.find((x) => x.id === p.provider && !x.configured) && (
          <div class="mt-3 text-[12px] text-warning">
            This provider has no credentials yet —{' '}
            <a href="#/config/providers" class="underline underline-offset-2">
              add a key or log in
            </a>
            .
          </div>
        )}

        <CustomModels models={p.customModels} baseUrl={p.customBaseUrl ?? ''} onBaseUrl={(v) => setP({ customBaseUrl: v })} onChange={(m) => setP({ customModels: m })} />
        <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
      </Panel>
    </div>
  );
}

function CustomModels(props: { models: CustomModel[]; baseUrl: string; onBaseUrl: (v: string) => void; onChange: (m: CustomModel[]) => void }) {
  const inherit = props.baseUrl.trim();
  const upd = (i: number, p: Partial<CustomModel>) => props.onChange(props.models.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const add = (preset?: Partial<CustomModel>) =>
    props.onChange([...props.models, { id: '', name: '', baseUrl: inherit ? '' : 'http://localhost:11434/v1', contextWindow: 32768, ...preset }]);
  return (
    <div class="mt-6">
      <div class="flex items-center gap-2 mb-2">
        <span class="hud-label text-[10px]">Custom models · OpenAI-compatible</span>
        <span class="ml-auto flex gap-1.5">
          <button class="btn btn-xs btn-ghost rounded-[2px] font-mono font-normal uppercase text-[10px] text-fg-2" onClick={() => add({ baseUrl: 'http://localhost:11434/v1', id: 'llama3.1:8b', name: 'Llama 3.1 8B (Ollama)' })}>
            + Ollama
          </button>
          <button class="btn btn-xs btn-ghost rounded-[2px] font-mono font-normal uppercase text-[10px] text-fg-2" onClick={() => add({ baseUrl: 'http://localhost:1234/v1', id: '', name: 'LM Studio model' })}>
            + LM Studio
          </button>
          <button class="btn btn-xs btn-outline border-line rounded-[2px] font-mono font-normal uppercase text-[10px] text-fg-2" onClick={() => add()}>
            <Plus size={11} /> Add
          </button>
        </span>
      </div>
      <div class="flex items-center gap-2 mb-2">
        <span class="font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 shrink-0">Provider base URL</span>
        <input
          class={`${INPUT} font-mono input-xs`}
          value={props.baseUrl}
          placeholder="https://api.example.com/v1 — used by models with an empty base URL"
          spellcheck={false}
          onInput={(e) => props.onBaseUrl((e.target as HTMLInputElement).value)}
        />
      </div>
      {props.models.length === 0 ? (
        <div class="border border-dashed border-line px-3 py-3 text-[12px] text-fg-3">
          Point Monarch at a local server (Ollama, LM Studio, vLLM…) or any OpenAI-compatible endpoint. Custom models appear under the <span class="font-mono">custom</span> provider.
        </div>
      ) : (
        <div class="overflow-x-auto border border-line">
          <table class="table table-xs">
            <thead>
              <tr class="border-line font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
                <th>Model id</th>
                <th>Name</th>
                <th>Base URL</th>
                <th>API key</th>
                <th class="w-24">Context</th>
                <th class="w-8" />
              </tr>
            </thead>
            <tbody>
              {props.models.map((m, i) => (
                <tr key={i} class="border-line">
                  <td>
                    <input class={`${INPUT} font-mono input-xs`} value={m.id} placeholder="llama3.1:8b" onInput={(e) => upd(i, { id: (e.target as HTMLInputElement).value })} spellcheck={false} />
                  </td>
                  <td>
                    <input class={`${INPUT} input-xs`} value={m.name} placeholder="Display name" onInput={(e) => upd(i, { name: (e.target as HTMLInputElement).value })} />
                  </td>
                  <td>
                    <input class={`${INPUT} font-mono input-xs min-w-[200px]`} value={m.baseUrl} placeholder={inherit ? `inherit · ${inherit}` : 'http://localhost:11434/v1'} onInput={(e) => upd(i, { baseUrl: (e.target as HTMLInputElement).value })} spellcheck={false} />
                  </td>
                  <td>
                    <input class={`${INPUT} font-mono input-xs`} type="password" value={m.apiKey ?? ''} placeholder="optional" autoComplete="off" onInput={(e) => upd(i, { apiKey: (e.target as HTMLInputElement).value || undefined })} />
                  </td>
                  <td>
                    <input
                      class={`${INPUT} font-mono input-xs`}
                      type="number"
                      min={1024}
                      step={1024}
                      value={m.contextWindow ?? ''}
                      onInput={(e) => {
                        const v = Number((e.target as HTMLInputElement).value);
                        upd(i, { contextWindow: v > 0 ? v : undefined });
                      }}
                    />
                  </td>
                  <td>
                    <button class="text-fg-3 hover:text-red p-1" title="Remove" onClick={() => props.onChange(props.models.filter((_, j) => j !== i))}>
                      <Trash2 size={12} strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {props.models.some((m) => !m.id.trim() || !(m.baseUrl.trim() || inherit)) && <div class="text-[11px] text-warning mt-1.5">Rows without a model id or base URL (own or provider) are skipped on save.</div>}
    </div>
  );
}
