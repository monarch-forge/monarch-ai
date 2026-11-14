/**
 * 9router — AI model router telemetry & management.
 * OWNED BY UI-A.
 */
import { useEffect, useState } from 'preact/hooks';
import { Panel, Stat, Tag } from '../components/ui.tsx';

interface ModelItem {
  id: string;
  owned_by?: string;
  context_length?: number;
}

export default function RouterPage(_props: { params: string[] }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [testModel, setTestModel] = useState('');
  const [testPrompt, setTestPrompt] = useState('Hello from Monarch');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const checkRouter = async () => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:20128/v1/models', { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.data ?? []);
      setModels(list);
      setAvailable(true);
      if (list.length > 0 && !testModel) setTestModel(list[0].id);
    } catch {
      setAvailable(false);
      setModels([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkRouter();
  }, []);

  const runTest = async () => {
    if (!testModel) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('http://localhost:20128/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: 'user', content: testPrompt }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2);
      setTestResult(reply);
    } catch (e: any) {
      setTestResult(`Error: ${e?.message ?? e}`);
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div class="h-full flex items-center justify-center font-mono text-xs text-fg-3">
        CONNECTING TO 9ROUTER (LOCALHOST:20128)…
      </div>
    );
  }

  if (!available) {
    return (
      <div class="h-full flex items-center justify-center p-6">
        <div class="hud-panel max-w-md w-full p-6 space-y-4 text-center">
          <div class="font-mono text-xs tracking-widest text-red uppercase">9Router Not Available</div>
          <div class="font-mono text-sm text-fg">9Router is not available on this device or has not been started.</div>
          <div class="font-mono text-xs text-fg-3">Expected OpenAI-compatible proxy at <code class="text-fg">http://localhost:20128/v1</code></div>
          <button
            onClick={checkRouter}
            class="px-4 py-2 font-mono text-xs uppercase border border-line bg-subtle hover:border-fg-2 text-fg transition"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="h-full overflow-y-auto">
      <div class="grid grid-cols-1 lg:grid-cols-6 xl:grid-cols-12 gap-3 p-3 xl:p-4">
        <Panel code="RTR.01" title="9Router Status" class="lg:col-span-6 xl:col-span-6">
          <div class="p-4 space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <div class="font-mono text-sm text-fg">Proxy Gateway Active</div>
                <div class="font-mono text-[11px] text-fg-3 mt-0.5">Connected to http://localhost:20128/v1</div>
              </div>
              <Tag tone="ok">ONLINE</Tag>
            </div>
            <div class="grid grid-cols-3 gap-3 pt-2 border-t border-line">
              <Stat label="Loaded Models" value={String(models.length)} />
              <Stat label="Protocol" value="OpenAI /v1" />
              <Stat label="Status" value="Ready" />
            </div>
          </div>
        </Panel>

        <Panel code="RTR.02" title="Model Gateway Test" class="lg:col-span-6 xl:col-span-6">
          <div class="p-4 space-y-3">
            <div class="font-mono text-xs text-fg-3">TEST PROXY FORWARDING (/v1/chat/completions):</div>
            <div class="flex gap-2">
              <select
                class="bg-surface border border-line px-2 py-1.5 font-mono text-xs text-fg flex-1"
                value={testModel}
                onChange={(e: any) => setTestModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.id}</option>
                ))}
              </select>
              <button
                disabled={testing || !testModel}
                onClick={runTest}
                class="px-4 py-1.5 font-mono text-xs uppercase border border-line bg-subtle hover:border-fg-2 text-fg transition disabled:opacity-50"
              >
                {testing ? 'Testing…' : 'Send Test'}
              </button>
            </div>
            <input
              type="text"
              class="w-full bg-surface border border-line px-2.5 py-1.5 font-mono text-xs text-fg"
              value={testPrompt}
              onInput={(e: any) => setTestPrompt(e.target.value)}
              placeholder="Prompt..."
            />
            {testResult && (
              <div class="p-2.5 border border-line bg-surface font-mono text-[11px] text-fg-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
                {testResult}
              </div>
            )}
          </div>
        </Panel>

        <Panel code="RTR.03" title="Available Models" class="lg:col-span-12 xl:col-span-12">
          <div class="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            {models.map((m) => (
              <div key={m.id} class="p-3 border border-line bg-subtle flex items-center justify-between font-mono text-xs">
                <div>
                  <div class="text-fg font-medium truncate max-w-[280px]" title={m.id}>{m.id}</div>
                  <div class="text-[10px] text-fg-3 mt-0.5">Owner: {m.owned_by ?? 'upstream'} {m.context_length ? `· ${m.context_length} ctx` : ''}</div>
                </div>
                <Tag tone="ok">ACTIVE</Tag>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
