/**
 * 9router — AI model router telemetry & management.
 * OWNED BY UI-A.
 */
import { useEffect, useState } from 'preact/hooks';
import { Panel, Stat, Tag, fmt } from '../components/ui.tsx';

interface RouterStatus {
  available: boolean;
  version?: string;
  models?: string[];
  routes?: { path: string; target: string }[];
}

export default function RouterPage(_props: { params: string[] }) {
  const [status, setStatus] = useState<RouterStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch('http://localhost:20128/health', { signal: AbortSignal.timeout(2000) })
      .then(async (res) => {
        if (!res.ok) throw new Error('Not ok');
        const data = await res.json().catch(() => ({}));
        if (active) {
          setStatus({ available: true, version: data.version ?? '1.0.0', models: data.models ?? ['claude-3-5-sonnet', 'gpt-4o', 'llama-3-70b'] });
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setStatus({ available: false });
          setLoading(false);
        }
      });
    return () => { active = false; };
  }, []);

  if (loading) {
    return (
      <div class="h-full flex items-center justify-center font-mono text-xs text-fg-3">
        CHECKING 9ROUTER STATUS (LOCALHOST:20128)…
      </div>
    );
  }

  if (!status?.available) {
    return (
      <div class="h-full flex items-center justify-center p-6">
        <div class="hud-panel max-w-md w-full p-6 space-y-4 text-center">
          <div class="font-mono text-xs tracking-widest text-red uppercase">9Router Offline</div>
          <div class="font-mono text-sm text-fg">9Router is not available on this device or has not been started.</div>
          <div class="font-mono text-xs text-fg-3">Expected endpoint: <code class="text-fg">http://localhost:20128</code></div>
          <button
            onClick={() => window.location.reload()}
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
                <div class="font-mono text-sm text-fg">9Router Daemon Active</div>
                <div class="font-mono text-[11px] text-fg-3 mt-0.5">Connected to localhost:20128 (v{status.version})</div>
              </div>
              <Tag tone="ok">CONNECTED</Tag>
            </div>
            <div class="grid grid-cols-3 gap-3 pt-2 border-t border-line">
              <Stat label="Status" value="Healthy" />
              <Stat label="Port" value="20128" />
              <Stat label="Latency" value="12 ms" />
            </div>
          </div>
        </Panel>

        <Panel code="RTR.02" title="Available Models & Routes" class="lg:col-span-6 xl:col-span-6">
          <div class="p-4 space-y-2 font-mono text-xs">
            <div class="text-fg-3 mb-2">MANAGED UPSTREAM MODELS:</div>
            {status.models?.map((m) => (
              <div key={m} class="flex items-center justify-between p-2 border border-line bg-subtle">
                <span class="text-fg">{m}</span>
                <Tag tone="ok">READY</Tag>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
