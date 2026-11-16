/** Config → Models: engine choice, Claude Agent SDK options, pi provider/model + custom OpenAI-compatible models. */
import { useState } from 'preact/hooks';
import type { CustomModel, EngineId, ModelInfo, ProviderStatus, Settings, ThinkingLevel } from '@monarch/shared';
import { Plus, Trash2 } from 'lucide-preact';
import { qs } from '../../lib/api.ts';
import { settings, useResource } from '../../lib/store.ts';
import { Panel, Tag, Spinner, ErrorLine } from '../ui.tsx';
import { ModelPicker, type ModelChoice } from '../chat/model-picker.tsx';
import { Field, INPUT, SELECT, RADIO, ToggleRow, SaveBar, saveSettings, useDraft, Kbd, Advanced } from './fields.tsx';

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
    <label class={`flex-1 flex gap-3 rounded-[10px] border p-4 cursor-pointer transition-colors duration-150 ${on ? 'border-fg-3 bg-raised' : 'border-transparent bg-raised/40 hover:bg-raised'}`}>
      <input type="radio" name="engine" class={`${RADIO} mt-0.5`} checked={on} onChange={() => props.onPick(props.id)} />
      <span>
        <span class="block text-[14px] font-medium text-fg">{props.title}</span>
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
    // custom providers are managed in Config → Providers; never send a stale copy back
    const { customProviders: _cp, customModels: _cm, customBaseUrl: _cb, ...pi } = draft.pi;
    const ok = await saveSettings({ engine: draft.engine, claudeSdk: draft.claudeSdk, pi });
    setSaving(false);
    if (ok) reset();
  };

  return (
    <div class="flex flex-col gap-4">
      <Panel title="Default engine" right={<Tag>{draft.engine === 'pi' ? 'pi' : 'claude sdk'}</Tag>}>
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
        </div>
        <div class="mt-3">
          <ToggleRow
            label="Use Claude subscription"
            hint="On: authenticate through your Claude Code login (Pro/Max). Off: use the Anthropic API key stored under Providers."
            checked={c.useSubscription}
            onChange={(v) => setC({ useSubscription: v })}
          />
          <Advanced>
          <Field label="Claude executable" hint="Absolute path to the `claude` CLI. Leave empty to auto-detect.">
            <input class={`${INPUT} font-mono`} value={c.executablePath} onInput={(e) => setC({ executablePath: (e.target as HTMLInputElement).value })} placeholder="auto-detect" spellcheck={false} />
          </Field>
          </Advanced>
        </div>
        <div class="mt-3 rounded-[8px] bg-raised px-4 py-3 text-[12.5px]">
          {providers.error && !providers.data ? (
            <ErrorLine error={providers.error} />
          ) : claudeProv?.configured ? (
            <div class="flex items-center gap-3 flex-wrap">
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-success" />
              <span class="text-fg">Signed in</span>
              {claudeProv.account && <span class="font-mono text-[11.5px] text-fg-2">{claudeProv.account}</span>}
              {claudeProv.source && <span class=" text-[12px] text-fg-3">via {claudeProv.source}</span>}
            </div>
          ) : (
            <div class="text-fg-2 leading-relaxed">
              <div class="flex items-center gap-2 mb-1">
                <span class="inline-block w-1.5 h-1.5 rounded-full bg-warning" />
                <span class="text-fg">No Claude Code login detected.</span>
              </div>
              Run <Kbd>claude auth login</Kbd> in a terminal, sign in with your Claude account, then come back — status refreshes automatically.
              {claudeProv?.error && <div class="font-mono text-[11px] text-fg-3 mt-1">{claudeProv.error}</div>}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Pi" active={draft.engine === 'pi'}>
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

        <div class="mt-5 text-[12px] text-fg-3">
          OpenAI-compatible endpoints (OpenRouter, Together, Groq, vLLM, Ollama, LM Studio…) are added as custom providers under{' '}
          <a href="#/config/providers" class="underline underline-offset-2 text-fg-2">
            Providers → Custom provider
          </a>
          ; their models then appear in the provider list above.
        </div>
        <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
      </Panel>

      <h2 class="text-[14.5px] font-semibold text-fg mt-4 px-1">Fine-tuning</h2>
      <p class="text-[12.5px] text-fg-3 -mt-2 px-1">Helpers, small models and how long conversations are kept in memory.</p>
      <WorkerModelPanel />
      <SmallModelPanel />
      <ContextPanel />
    </div>
  );
}

/** Settings.agent.autoCompactPercent — when a session's context gets compacted automatically */
function ContextPanel() {
  const s = settings.value!;
  const [draft, set, dirty, reset] = useDraft<{ pct: number }>({ pct: s.agent?.autoCompactPercent ?? 75 });
  const [saving, setSaving] = useState(false);
  if (!draft) return null;
  const on = draft.pct > 0;
  const save = async () => {
    setSaving(true);
    const ok = await saveSettings({ agent: { ...(s.agent ?? {}), autoCompactPercent: Math.max(0, Math.min(95, Math.round(draft.pct))) } });
    setSaving(false);
    if (ok) reset();
  };
  return (
    <Panel title="Context" right={<Tag tone={on ? 'ok' : 'warn'}>{on ? `auto ${draft.pct}%` : 'auto off'}</Tag>}>
      <ToggleRow
        label="Auto-compact context"
        hint="When a session's context reaches the threshold, older turns are summarized so the conversation keeps fitting the model window. /compact does it on demand."
        checked={on}
        onChange={(v) => set({ pct: v ? 75 : 0 })}
      />
      {on && (
        <div class="mt-3 max-w-[260px]">
          <Field label="Threshold (% of context window)" hint="Claude SDK: passed to Claude Code (it can only lower its own default). Pi: Monarch summarizes with the session's model.">
            <input
              type="number"
              min={5}
              max={95}
              class={`${INPUT} font-mono`}
              value={draft.pct}
              onInput={(e) => set({ pct: Number((e.target as HTMLInputElement).value) || 0 })}
            />
          </Field>
        </div>
      )}
      {!on && <div class="mt-2 text-[11.5px] text-fg-3">Off: pi sessions are never compacted automatically; Claude Code still compacts at its own default near the limit.</div>}
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
    </Panel>
  );
}


type SmallMode = 'auto' | 'on' | 'off';

/** Settings.agent.smallModelMode — adapt prompts and tools for small/fast models */
function SmallModelPanel() {
  const s = settings.value!;
  const [draft, set, dirty, reset] = useDraft<{ mode: SmallMode }>({ mode: s.agent?.smallModelMode ?? 'auto' });
  const [saving, setSaving] = useState(false);
  if (!draft) return null;
  const save = async () => {
    setSaving(true);
    const ok = await saveSettings({ agent: { ...(s.agent ?? {}), smallModelMode: draft.mode } });
    setSaving(false);
    if (ok) reset();
  };
  return (
    <Panel title="Small-model mode" right={<Tag tone={draft.mode === 'off' ? 'warn' : 'ok'}>{draft.mode}</Tag>}>
      <div class="max-w-[260px]">
        <Field
          label="Mode"
          hint="Auto turns it on for flash / lite / mini / haiku / nano / small 7–9B models or context windows under 64k: common tools loaded up front, a compact prompt, compact coding-agent results."
        >
          <select class={SELECT} value={draft.mode} onChange={(e) => set({ mode: (e.target as HTMLSelectElement).value as SmallMode })}>
            <option value="auto">Auto (detect from the model)</option>
            <option value="on">Always on</option>
            <option value="off">Off</option>
          </select>
        </Field>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
    </Panel>
  );
}

/** Settings.agent.workerModel — default runtime/model for worker agents started by Monarch */
function WorkerModelPanel() {
  const s = settings.value!;
  const w = s.agent?.workerModel ?? null;
  const save = async (c: ModelChoice | null) => {
    await saveSettings({ agent: { ...(s.agent ?? {}), workerModel: c ? { engine: c.engine, model: c.model } : null } }, c ? `Worker agents: ${c.model}` : 'Worker agents use the default model');
  };
  return (
    <Panel title="Worker agents" right={<Tag tone={w ? 'ok' : undefined}>{w ? w.model : 'same as default'}</Tag>}>
      <div class="flex flex-col gap-2 max-w-[560px]">
        <div class="text-[12.5px] text-fg-2 leading-relaxed">
          Monarch does quick things itself and hands heavy work (code, full inbox triage, research, planning, long drafts) to worker agents in the Workshop. Give them a stronger model here so
          your manager can stay on a fast one. Monarch still uses another model when you ask for one.
        </div>
        <div class="flex items-center gap-3">
          <ModelPicker value={w} onChange={(c) => void save(c)} placement="down" title="Default model for worker agents" />
          <span class="text-[11px] text-fg-3">“Default” = the same engine and model as Monarch.</span>
        </div>
      </div>
    </Panel>
  );
}
