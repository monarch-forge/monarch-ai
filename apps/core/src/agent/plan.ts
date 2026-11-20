/** Plan-then-execute for coding workers: the plan a worker sets (plan_set), ticks (plan_step), and the done-gate. */
import type { PlanStep } from '@monarch/shared';

export const MAX_PLAN_STEPS = 8;
/** plans up to this size need no summary to anyone */
export const AUTO_APPROVE_STEPS = 5;

export function newPlan(steps: { text: string; files?: string[] }[]): PlanStep[] {
  if (!steps.length) throw new Error('A plan needs at least one step.');
  if (steps.length > MAX_PLAN_STEPS) throw new Error(`At most ${MAX_PLAN_STEPS} steps: merge small ones.`);
  return steps.map((s) => ({ text: s.text.trim().slice(0, 300), ...(s.files?.length ? { files: s.files.slice(0, 10) } : {}), status: 'open' as const }));
}

/** 1-based indexes of steps still open */
export function openSteps(plan: PlanStep[] | undefined): number[] {
  return (plan ?? []).flatMap((s, i) => (s.status === 'open' ? [i + 1] : []));
}

/** follow-up for a worker that stopped with open steps, or null when the plan is finished (or absent) */
export function planGateMessage(plan: PlanStep[] | undefined): string | null {
  const open = openSteps(plan);
  if (!open.length) return null;
  const list = open.map((n) => `${n}. ${plan![n - 1].text}`).join('; ');
  return `[Monarch plan] Step${open.length > 1 ? 's' : ''} ${open.join(', ')} ${open.length > 1 ? 'are' : 'is'} still open: ${list}. Finish them or mark skipped with a reason (plan_step).`;
}

export function formatPlan(plan: PlanStep[]): string {
  const mark = { open: '[ ]', done: '[x]', skipped: '[-]' } as const;
  return plan.map((s, i) => `${mark[s.status]} ${i + 1}. ${s.text}${s.files?.length ? ` (${s.files.join(', ')})` : ''}${s.note ? ` — ${s.note}` : ''}`).join('\n');
}
