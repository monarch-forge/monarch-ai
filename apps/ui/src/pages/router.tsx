/**
 * 9router — AI model router telemetry & management.
 * OWNED BY UI-A.
 */
import { useEffect, useState } from 'preact/hooks';
import { ExternalLink } from 'lucide-preact';
import { Skeleton } from '../components/ui.tsx';

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
    await invoke('open_router_window', { url: `${ROUTER_URL}/dashboard/usage` });
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
      <div class="h-full p-4" aria-label="Connecting to 9Router">
        <Skeleton h={9999} class="!h-full w-full opacity-60" />
      </div>
    );
  }

  if (!available) {
    return (
      <div class="h-full flex items-center justify-center p-6">
        <div class="max-w-sm w-full bg-base-200 rounded-[14px] px-6 py-7 text-center">
          <div class="text-[15px] font-semibold text-fg">9Router isn’t running</div>
          <div class="mt-2 text-[13px] text-fg-2 leading-relaxed">
            Start it on this device and we’ll pick it up. Monarch looks for it at <code class="font-mono text-[12px] text-fg">{ROUTER_URL}</code>.
          </div>
          <button
            onClick={checkRouter}
            class="mt-5 px-3.5 py-1.5 rounded-[var(--radius-control)] text-[13px] bg-subtle text-fg hover:bg-white/[0.1] transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="h-full flex flex-col p-3 sm:p-4 lg:p-5 gap-2.5">
      <div class="flex items-center gap-2 px-1 min-w-0">
        <span class="w-1.5 h-1.5 rounded-full bg-success/80 shrink-0" title="Connected" />
        <span class="text-[13px] font-medium text-fg-2">9Router</span>
        <span class="font-mono text-[11px] text-fg-3 truncate" title={ROUTER_URL}>{ROUTER_LABEL.toLowerCase()}</span>
        <span class="ml-auto flex items-center gap-2 min-w-0">
          {openError && <span class="text-[12px] text-red/90 truncate max-w-[320px]" title={openError}>{openError}</span>}
          {IN_TAURI && (
            <button
              onClick={() => void openRouterWindow().then(setOpenError)}
              class="inline-flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-control)] text-[12.5px] text-fg-3 hover:text-fg hover:bg-subtle transition-colors"
              title="Pop 9Router out into its own window"
            >
              <ExternalLink size={13} /> Open in window
            </button>
          )}
        </span>
      </div>
      <div class="flex-1 min-h-0 rounded-[10px] overflow-hidden bg-base-200">
        <iframe
          src={`${ROUTER_URL}/dashboard/usage`}
          title="9Router Dashboard"
          // 9Router follows prefers-color-scheme ("system" theme); the iframe element's color-scheme is
          // what the embedded page sees (WebKitGTK ignores the parent page's scheme), so force dark here
          style={{ colorScheme: 'dark' }}
          class="w-full h-full border-0 bg-base-200"
        />
      </div>
    </div>
  );
}
