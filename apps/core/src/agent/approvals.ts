/**
 * Shared approval gate for risky tool calls (both engines).
 *
 * Policy (settings.permissions.mode):
 *   ask        → ask for sensitive + dangerous
 *   auto       → Auto mode: ask only for dangerous; an approval is remembered for the session; approvals notify.
 *                Calls with a target (ToolDef.target: recipient/channel/repo) instead ask once per NEW target,
 *                any risk, remembered globally (approved-targets); bulkCount > BULK_LIMIT always asks.
 *   auto-safe  → ask only for dangerous
 *   auto-all   → never ask
 * plus per-session "always allow <tool>" allowances granted via approval.respond {always:true}.
 */
import type { ApprovalRequest, ToolRisk } from '@monarch/shared';
import { bus, newId, notify, nowIso } from '../kernel.ts';
import { getSession } from './sessions.ts';
import { getSettings } from '../settings.ts';
import { serviceStore } from '../services/persist.ts';

interface Pending {
  req: ApprovalRequest;
  target?: string;
  resolve: (allowed: boolean) => void;
}

const pending = new Map<string, Pending>();
const allowances = new Map<string, Set<string>>(); // sessionId -> tool names

/** what the call acts on (auto mode only): target = recipient/channel/repo key, bulk = item count */
export interface ApprovalScope {
  target?: string;
  bulk?: number;
}

export const BULK_LIMIT = 25;
const targetStore = serviceStore<{ targets: string[] }>('approved-targets', { targets: [] });

export function isApprovedTarget(target: string): boolean {
  return targetStore.get().targets.includes(target);
}

export function approveTarget(target: string): void {
  if (!isApprovedTarget(target)) targetStore.update((s) => ({ targets: [...s.targets, target] }));
}

export function needsApproval(sessionId: string, toolName: string, risk: ToolRisk, scope: ApprovalScope = {}): boolean {
  const mode = getSettings().permissions.mode;
  if (mode === 'auto' && (scope.bulk ?? 0) > BULK_LIMIT) return true;
  if (allowances.get(sessionId)?.has(toolName)) return false;
  if (mode === 'auto' && scope.target && risk !== 'safe') return !isApprovedTarget(scope.target);
  if (mode === 'auto-all') return false;
  if (mode === 'auto-safe' || mode === 'auto') return risk === 'dangerous';
  return risk !== 'safe';
}

/**
 * Resolve to true when the call may run. Asks the UI (approval.request) when policy requires;
 * resolves false when denied or when the session is aborted.
 */
export function requestApproval(
  sessionId: string,
  toolName: string,
  input: unknown,
  risk: ToolRisk,
  summary: string,
  signal?: AbortSignal,
  scope: ApprovalScope = {},
): Promise<boolean> {
  if (!needsApproval(sessionId, toolName, risk, scope)) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  const req: ApprovalRequest = { id: newId(), sessionId, tool: toolName, input, risk, summary, ts: nowIso() };
  return new Promise<boolean>((resolve) => {
    const onAbort = () => settle(req.id, false);
    pending.set(req.id, {
      req,
      target: scope.target,
      resolve: (allowed) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(allowed);
      },
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    bus.broadcast({ type: 'approval.request', request: req });
    if (autoMode()) {
      const rec = getSession(sessionId);
      const href = rec?.kind === 'coding' ? `#/workshop/${encodeURIComponent(sessionId)}` : `#/chat/${encodeURIComponent(sessionId)}`;
      notify('Needs your approval', summary || toolName, 'warn', href);
    }
  });
}

function settle(id: string, allowed: boolean): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  bus.broadcast({ type: 'approval.resolved', id, allowed });
  p.resolve(allowed);
  return true;
}

/** handle approval.respond from the UI */
export function respondApproval(id: string, allow: boolean, always?: boolean): boolean {
  const p = pending.get(id);
  if (!p) return false;
  // auto mode with a target: remember the target (globally), not the whole tool
  if (allow && autoMode() && p.target && !always) approveTarget(p.target);
  else if (allow && (always || autoMode())) {
    let set = allowances.get(p.req.sessionId);
    if (!set) allowances.set(p.req.sessionId, (set = new Set()));
    set.add(p.req.tool);
  }
  return settle(id, allow);
}

/** deny every pending approval of a session (abort / delete) */
export function rejectSessionApprovals(sessionId: string): void {
  for (const [id, p] of [...pending]) if (p.req.sessionId === sessionId) settle(id, false);
}

export function clearSessionAllowances(sessionId: string): void {
  allowances.delete(sessionId);
}

export function pendingApprovals(): ApprovalRequest[] {
  return [...pending.values()].map((p) => p.req).sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

export function hasPendingFor(sessionId: string): boolean {
  for (const p of pending.values()) if (p.req.sessionId === sessionId) return true;
  return false;
}

export const autoMode = (): boolean => getSettings().permissions.mode === 'auto';
