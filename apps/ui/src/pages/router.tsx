/**
 * 9router — AI model router telemetry & management.
 * OWNED BY UI-A.
 */
import { useEffect, useState } from 'preact/hooks';
import { Panel, Tag } from '../components/ui.tsx';

export default function RouterPage(_props: { params: string[] }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  const checkRouter = async () => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:20128/v1/models', { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error('Failed');
      setAvailable(true);
    } catch {
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkRouter();
  }, []);

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
          <div class="font-mono text-xs text-fg-3">Expected service at <code class="text-fg">http://localhost:20128</code></div>
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
    <div class="h-full flex flex-col p-3 xl:p-4 gap-3">
      <div class="flex items-center justify-between px-1">
        <div class="font-mono text-xs tracking-wider uppercase text-fg-2 flex items-center gap-2">
          <span class="w-2 h-2 bg-success inline-block" />
          9Router Gateway Console
        </div>
        <Tag tone="ok">LOCALHOST:20128</Tag>
      </div>
      <div class="flex-1 min-h-0 hud-panel overflow-hidden">
        <iframe
          src="http://localhost:20128"
          title="9Router Dashboard"
          class="w-full h-full border-0 bg-[#121213]"
        />
      </div>
    </div>
  );
}
