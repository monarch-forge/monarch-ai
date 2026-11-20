/** Worker plan checklist (plan_set / plan_step), live via session.updated. */
import type { PlanStep } from '@monarch/shared';
import { Check, Circle, Minus } from 'lucide-preact';

export function PlanPanel(props: { plan?: PlanStep[] }) {
  const plan = props.plan;
  if (!plan?.length) return null;
  const closed = plan.filter((s) => s.status !== 'open').length;
  return (
    <div>
      <div class="text-[12px] text-fg-3 mb-1.5">
        Plan · {closed}/{plan.length}
      </div>
      <ol class="flex flex-col gap-1">
        {plan.map((s, i) => (
          <li key={i} class="flex gap-2 text-[12.5px] leading-snug" title={s.files?.join(', ')}>
            <span class="mt-[2px] shrink-0 text-fg-3" aria-label={s.status}>
              {s.status === 'done' ? <Check size={13} class="text-success" /> : s.status === 'skipped' ? <Minus size={13} /> : <Circle size={11} class="mt-[1px]" />}
            </span>
            <span class={s.status === 'open' ? 'text-fg-2' : 'text-fg-3'}>
              <span class={s.status === 'skipped' ? 'line-through' : ''}>{s.text}</span>
              {s.note && <span class="block text-[11px] text-fg-3">{s.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
