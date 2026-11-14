/**
 * 9router — AI model router telemetry & management.
 * OWNED BY UI-A.
 */
import { Panel, Stat, Tag, fmt } from '../components/ui.tsx';
import { useResource } from '../lib/store.ts';

export default function RouterPage(_props: { params: string[] }) {
  const routes = useResource<{ providers: { name: string; active: boolean; latencyMs: number; reqCount: number }[] }>('/system/info');
  return (
    <div class="h-full overflow-y-auto">
      <div class="grid grid-cols-1 lg:grid-cols-6 xl:grid-cols-12 gap-3 p-3 xl:p-4">
        <Panel code="RTR.01" title="9Router Status" class="lg:col-span-6 xl:col-span-6">
          <div class="p-4 space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <div class="font-mono text-sm text-fg">Active Router Daemon</div>
                <div class="font-mono text-[11px] text-fg-3 mt-0.5">Multiplexing requests across connected LLM providers</div>
              </div>
              <Tag tone="ok">ONLINE</Tag>
            </div>
            <div class="grid grid-cols-3 gap-3 pt-2 border-t border-line">
              <Stat label="Total Routed" value="1,428" />
              <Stat label="Avg Latency" value="214 ms" />
              <Stat label="Success Rate" value="99.8%" />
            </div>
          </div>
        </Panel>

        <Panel code="RTR.02" title="Provider Weights & Failover" class="lg:col-span-6 xl:col-span-6">
          <div class="p-4 space-y-3 font-mono text-xs">
            <div class="flex items-center justify-between p-2 border border-line bg-subtle">
              <span>Claude Agent SDK (Primary)</span>
              <span class="text-success">Weight: 70%</span>
            </div>
            <div class="flex items-center justify-between p-2 border border-line bg-subtle">
              <span>OpenAI GPT-4o (Fallback)</span>
              <span class="text-fg-2">Weight: 20%</span>
            </div>
            <div class="flex items-center justify-between p-2 border border-line bg-subtle">
              <span>Groq / Llama 3 (Fast Path)</span>
              <span class="text-fg-2">Weight: 10%</span>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
