/** Shared bits for the Evolve page: unavailable state, status/origin/risk markers, small helpers. */
import type { ComponentChildren } from 'preact';
import type { ExtensionOrigin, ExtensionPermission, ExtensionStatus, ToolRisk } from '@monarch/shared';
import { Dna } from 'lucide-preact';
import { conn, navigate, type Resource } from '../../lib/store.ts';
import { Spinner, Tag } from '../ui.tsx';
import { RetryLink } from '../overview/common.tsx';

/** true when the error means the endpoint does not exist (yet) */
export function isMissing(error: string | undefined): boolean {
  return !!error && /^not found:/i.test(error);
}

/** muted centred note for Evolve panels */
export function EvoNote(props: { label: string; sub?: ComponentChildren; spinner?: boolean; action?: ComponentChildren; icon?: boolean; class?: string }) {
  return (
    <div class={`flex flex-col items-center justify-center gap-2 text-center px-4 py-10 ${props.class ?? ''}`}>
      {props.icon && <Dna size={26} strokeWidth={1} class="text-fg-3 mb-1" />}
      <div class="flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] uppercase text-fg-3">
        {props.spinner ? <Spinner /> : <span class="inline-block w-1.5 h-1.5 border border-fg-3" />}
        {props.label}
      </div>
      {props.sub && <div class="text-[12px] text-fg-3 max-w-[44ch] leading-relaxed">{props.sub}</div>}
      {props.action}
    </div>
  );
}

/**
 * Render resource data or a quiet state: offline / evolution service unavailable (404) / error / loading.
 * Stale data stays on screen while offline.
 */
export function EvoGate<T>(props: { res: Resource<T>; children: (data: T) => ComponentChildren; loadingLabel?: string }) {
  const { data, error, loading } = props.res;
  if (data !== undefined && data !== null) return <>{props.children(data)}</>;
  if (conn.value !== 'open') return <EvoNote label={conn.value === 'connecting' ? 'Linking core' : 'Core offline'} spinner={conn.value === 'connecting'} />;
  if (isMissing(error)) return <EvoNote icon label="Evolution service unavailable" sub="This core build does not expose the self-evolution API yet." action={<RetryLink onClick={() => void props.res.reload()} />} />;
  if (error) return <EvoNote label="Unavailable" sub={error} action={<RetryLink onClick={() => void props.res.reload()} />} />;
  if (loading) return <EvoNote label={props.loadingLabel ?? 'Loading'} spinner />;
  return <EvoNote label="No data" />;
}

/* ─────────── markers ─────────── */

const STATUS_DOT: Record<ExtensionStatus, string> = {
  active: 'bg-fg',
  starting: 'bg-fg-2 hud-blink',
  error: 'bg-red',
  disabled: 'border border-fg-3',
};

export function StatusDot(props: { status: ExtensionStatus; class?: string }) {
  return <span class={`inline-block w-1.5 h-1.5 shrink-0 ${STATUS_DOT[props.status] ?? STATUS_DOT.disabled} ${props.class ?? ''}`} title={props.status} aria-label={`status ${props.status}`} />;
}

export function StatusTag(props: { status: ExtensionStatus }) {
  const tone = props.status === 'error' ? 'red' : props.status === 'active' ? 'default' : 'plain';
  return <Tag tone={tone}>{props.status}</Tag>;
}

export function OriginTag(props: { origin: ExtensionOrigin | 'user' | 'agent' }) {
  return (
    <Tag tone="plain" title={ORIGIN_HINT[props.origin]} class={props.origin === 'agent' ? 'text-fg!' : ''}>
      {props.origin}
    </Tag>
  );
}
const ORIGIN_HINT: Record<string, string> = {
  builtin: 'Shipped with Monarch',
  user: 'Written or edited by you',
  agent: 'Written by Monarch itself',
};

export function RiskTag(props: { risk: ToolRisk }) {
  const tone = props.risk === 'dangerous' ? 'red' : props.risk === 'sensitive' ? 'warn' : 'plain';
  return <Tag tone={tone}>{props.risk}</Tag>;
}

export const PERMISSION_HINT: Record<ExtensionPermission, string> = {
  network: 'Outbound HTTP requests (fetch) to any host',
  shell: 'Spawn processes and run shell commands',
  fs: 'Read and write files outside its own data folder',
  secrets: 'Read the secrets you store for this extension',
};

export function PermTag(props: { perm: ExtensionPermission }) {
  const strong = props.perm === 'shell' || props.perm === 'fs';
  return (
    <Tag tone={strong ? 'warn' : 'default'} title={PERMISSION_HINT[props.perm] ?? props.perm}>
      {props.perm}
    </Tag>
  );
}

/** section heading inside a detail pane */
export function SectionHead(props: { label: string; right?: ComponentChildren; count?: number }) {
  return (
    <div class="flex items-center gap-2 mb-2">
      <span class="hud-label text-[10px] text-fg-2">{props.label}</span>
      {props.count !== undefined && <span class="font-mono text-[10px] text-fg-3">{props.count}</span>}
      <span class="flex-1 h-px bg-line" aria-hidden="true" />
      {props.right}
    </div>
  );
}

/** open a chat session in Comms */
export function openSession(id: string | undefined): void {
  if (id) navigate(`comms/${encodeURIComponent(id)}`);
}

/** "3m ago" style relative time for past instants */
export function ago(iso: string | undefined | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function stamp(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** read the message of an unknown error */
export function errMsg(e: unknown): string {
  return (e as any)?.message ?? String(e);
}

/** chunky mono textarea used for source / JSON / markdown editing */
export const CODE_AREA =
  'w-full bg-[#121213] border border-line rounded-[2px] font-mono text-[12px] leading-[1.6] text-fg p-3 resize-y focus:outline-none focus:border-fg-3 [tab-size:2]';

/** insert two spaces on Tab inside a textarea instead of moving focus (Esc then Tab still leaves) */
export function tabIndentHandler(e: KeyboardEvent, onValue: (v: string) => void): void {
  const ta = e.currentTarget as HTMLTextAreaElement & { _escaped?: boolean };
  if (e.key === 'Escape') {
    ta._escaped = true;
    return;
  }
  if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
    ta._escaped = false;
    return;
  }
  if (ta._escaped) {
    ta._escaped = false;
    return;
  }
  e.preventDefault();
  const { selectionStart: s, selectionEnd: en, value } = ta;
  const next = value.slice(0, s) + '  ' + value.slice(en);
  ta.value = next;
  ta.selectionStart = ta.selectionEnd = s + 2;
  onValue(next);
}
