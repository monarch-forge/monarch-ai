/**
 * 9router — AI model router telemetry & management.
 * OWNED BY UI-A.
 */
import { useEffect, useState } from 'preact/hooks';
import { Tag } from '../components/ui.tsx';

/** 9Router base URL; override with localStorage['monarch.router.url'] (loopback only in the desktop app). */
const ROUTER_URL = (() => {
  try {
    const v = localStorage.getItem('monarch.router.url')?.trim();
    if (v) return v.replace(/\/+$/, '');
  } catch {
    /* storage unavailable */
  }
  // localhost (not 127.0.0.1): same-site with the Vite dev origin http://localhost:5173, so the
  // iframe's SameSite=Lax cookie works under `npm run dev`.
  return 'http://localhost:20128';
})();
const ROUTER_LABEL = ROUTER_URL.replace(/^https?:\/\//, '').toUpperCase();

/**
 * The iframe needs the UI to be same-site with 9Router (its session cookie is SameSite=Lax): dev runs on
 * http://localhost:5173 and release builds serve the UI from http://localhost:7719 (tauri-plugin-localhost).
 * "Open in window" (open_router_window in lib.rs) remains as an optional pop-out in the desktop app.
 */
const IN_TAURI = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

async function openRouterWindow(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_router_window', { url: ROUTER_URL });
    return null;
  } catch (e) {
    return String(e);
  }
}

export default function RouterPage(_props: { params: string[] }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [openError, setOpenError] = useState<string | null>(null);

  const checkRouter = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${ROUTER_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
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
        CONNECTING TO 9ROUTER ({ROUTER_LABEL})…
      </div>
    );
  }

  if (!available) {
    return (
      <div class="h-full flex items-center justify-center p-6">
        <div class="hud-panel max-w-md w-full p-6 space-y-4 text-center">
          <div class="font-mono text-xs tracking-widest text-red uppercase">9Router Not Available</div>
          <div class="font-mono text-sm text-fg">9Router is not available on this device or has not been started.</div>
          <div class="font-mono text-xs text-fg-3">Expected service at <code class="text-fg">{ROUTER_URL}</code></div>
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
        <span class="flex items-center gap-2">
          {openError && <span class="font-mono text-[10px] text-red truncate max-w-[320px]" title={openError}>{openError}</span>}
          {IN_TAURI && (
            <button
              onClick={() => void openRouterWindow().then(setOpenError)}
              class="font-mono text-[10px] tracking-wider uppercase border border-line px-2 py-0.5 text-fg-2 hover:text-fg hover:border-fg-3"
              title="Pop 9Router out into its own window"
            >
              Open in window
            </button>
          )}
          <Tag tone="ok">{ROUTER_LABEL}</Tag>
        </span>
      </div>
      <div class="flex-1 min-h-0 hud-panel overflow-hidden">
        <iframe
          src={ROUTER_URL}
          title="9Router Dashboard"
          // 9Router follows prefers-color-scheme ("system" theme); the iframe element's color-scheme is
          // what the embedded page sees (WebKitGTK ignores the parent page's scheme), so force dark here
          style={{ colorScheme: 'dark' }}
          class="w-full h-full border-0 bg-[#121213]"
        />
      </div>
    </div>
  );
}
