/** Live view of an interactive OAuth flow (LLM provider login or Google account connect). */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { OAuthFlowState } from '@monarch/shared';
import { ExternalLink, Copy, X } from 'lucide-preact';
import { api, openExternal } from '../../lib/api.ts';
import { oauthFlows, toast } from '../../lib/store.ts';
import { copyText } from '../chat/markdown.tsx';
import { INPUT } from './fields.tsx';

const STATUS_TEXT: Record<OAuthFlowState['status'], string> = {
  starting: 'Starting…',
  'awaiting-browser': 'Waiting for browser sign-in',
  'awaiting-code': 'Paste the code from the browser',
  working: 'Finishing…',
  done: 'Connected',
  error: 'Failed',
};

export function useOAuthFlow(initial: OAuthFlowState | null): OAuthFlowState | null {
  if (!initial) return null;
  return oauthFlows.value[initial.flowId] ?? initial;
}

export function OAuthFlowView(props: { initial: OAuthFlowState; autoOpen?: boolean; onFinished?: (f: OAuthFlowState) => void; onDismiss?: () => void }) {
  const flow = useOAuthFlow(props.initial)!;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const opened = useRef(false);
  const finished = useRef(false);

  useEffect(() => {
    if (props.autoOpen && flow.url && !opened.current) {
      opened.current = true;
      void openExternal(flow.url);
    }
  }, [flow.url]);

  useEffect(() => {
    if ((flow.status === 'done' || flow.status === 'error') && !finished.current) {
      finished.current = true;
      props.onFinished?.(flow);
    }
  }, [flow.status]);

  const submitCode = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const next = await api.post<OAuthFlowState>(`/oauth/${encodeURIComponent(flow.flowId)}/code`, { code: code.trim() });
      if (next?.flowId) oauthFlows.value = { ...oauthFlows.value, [next.flowId]: next };
      setCode('');
    } catch (e: any) {
      toast(`Code rejected: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await api.post(`/oauth/${encodeURIComponent(flow.flowId)}/cancel`, {});
    } catch {
      /* flow may already be gone */
    }
    props.onDismiss?.();
  };

  const terminal = flow.status === 'done' || flow.status === 'error';
  const tone = flow.status === 'done' ? 'border-success/40' : flow.status === 'error' ? 'border-red/50' : 'border-warning/40';

  return (
    <div class={`border ${tone} bg-[#121213] p-3 flex flex-col gap-2.5`}>
      <div class="flex items-center gap-2">
        <span class={`inline-block w-1.5 h-1.5 ${flow.status === 'done' ? 'bg-success' : flow.status === 'error' ? 'bg-red' : 'bg-warning hud-blink'}`} />
        <span class="font-mono text-[11px] tracking-[0.12em] uppercase text-fg">{STATUS_TEXT[flow.status]}</span>
        <span class="font-mono text-[10px] text-fg-3">{flow.provider}</span>
        <button class="ml-auto text-fg-3 hover:text-fg" title={terminal ? 'Dismiss' : 'Cancel login'} onClick={() => (terminal ? props.onDismiss?.() : void cancel())}>
          <X size={13} />
        </button>
      </div>
      {flow.instructions && <div class="text-[12.5px] text-fg-2 leading-relaxed whitespace-pre-wrap">{flow.instructions}</div>}
      {flow.message && <div class="text-[12px] text-fg-3">{flow.message}</div>}
      {flow.userCode && (
        <div class="flex items-center gap-3">
          <span class="hud-label">Code</span>
          <span class="font-mono text-lg tracking-[0.2em] text-fg border border-line px-3 py-1 select-all">{flow.userCode}</span>
          <button class="text-fg-3 hover:text-fg" title="Copy code" onClick={() => void copyText(flow.userCode!, 'Code copied')}>
            <Copy size={12} />
          </button>
        </div>
      )}
      {flow.url && !terminal && (
        <div class="flex items-center gap-2 min-w-0">
          <span class="font-mono text-[11px] text-fg-3 truncate flex-1 border border-line px-2 py-1 bg-surface" title={flow.url}>
            {flow.url}
          </span>
          <button class="btn btn-xs btn-primary rounded-[2px] font-mono font-normal uppercase text-[10px]" onClick={() => void openExternal(flow.url!)}>
            <ExternalLink size={11} /> Open
          </button>
          <button class="btn btn-xs btn-outline border-line rounded-[2px] font-mono font-normal uppercase text-[10px] text-fg-2" onClick={() => void copyText(flow.url!, 'Link copied')}>
            <Copy size={11} /> Copy
          </button>
        </div>
      )}
      {flow.status === 'awaiting-code' && (
        <div class="flex items-center gap-2">
          <input
            class={INPUT}
            placeholder="Paste authorization code"
            value={code}
            onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && void submitCode()}
            autoFocus
            spellcheck={false}
          />
          <button class="btn btn-sm btn-primary rounded-[2px] font-mono font-normal uppercase text-[11px]" disabled={busy || !code.trim()} onClick={() => void submitCode()}>
            {busy && <span class="loading loading-spinner loading-xs" />}Submit
          </button>
        </div>
      )}
      {flow.error && <div class="font-mono text-[11.5px] text-red break-words">{flow.error}</div>}
    </div>
  );
}
