/**
 * Shared approval gate for risky tool calls (both engines).
 *
 * Policy (settings.permissions.mode):
 *   ask        → ask for sensitive + dangerous
 *   auto-safe  → ask only for dangerous
 *   auto-all   → never ask
 * plus per-session "always allow <tool>" allowances granted via approval.respond {always:true}.
 */
import type { ApprovalRequest, ToolRisk } from '@monarch/shared';
import { bus, newId, nowIso } from '../kernel.ts';
import { getSettings } from '../settings.ts';

interface Pending {
  req: ApprovalRequest;
  resolve: (allowed: boolean) => void;
}

const pending = new Map<string, Pending>();
const allowances = new Map<string, Set<string>>(); // sessionId -> tool names

export function needsApproval(sessionId: string, toolName: string, risk: ToolRisk): boolean {
  if (allowances.get(sessionId)?.has(toolName)) return false;
  const mode = getSettings().permissions.mode;
  if (mode === 'auto-all') return false;
  if (mode === 'auto-safe') return risk === 'dangerous';
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
): Promise<boolean> {
  if (!needsApproval(sessionId, toolName, risk)) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  const req: ApprovalRequest = { id: newId(), sessionId, tool: toolName, input, risk, summary, ts: nowIso() };
  return new Promise<boolean>((resolve) => {
    const onAbort = () => settle(req.id, false);
    pending.set(req.id, {
      req,
      resolve: (allowed) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(allowed);
      },
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    bus.broadcast({ type: 'approval.request', request: req });
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
  if (allow && always) {
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
