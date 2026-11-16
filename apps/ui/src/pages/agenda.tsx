/**
 * Agenda — week calendar (local + Google merged), tasks and automations.
 * Route: #/agenda
 */
import { useMemo } from 'preact/hooks';
import type { GoogleAccount } from '@monarch/shared';
import { useResource } from '../lib/store.ts';
import { WeekCalendar } from '../components/agenda/week.tsx';
import { TasksPanel } from '../components/agenda/tasks.tsx';
import { AutomationsPanel } from '../components/agenda/automations.tsx';

export default function AgendaPage(_props: { params: string[] }) {
  const acc = useResource<GoogleAccount[]>('/google/accounts', ['google']);
  const accounts = useMemo(() => (Array.isArray(acc.data) ? acc.data.filter((a) => a && typeof a.id === 'string') : []), [acc.data]);
  return (
    <div class="h-full overflow-y-auto lg:overflow-hidden p-3 sm:p-4 lg:p-5 flex flex-col lg:flex-row gap-4 min-h-0">
      <div class="flex min-h-[420px] lg:min-h-0 lg:flex-1 min-w-0">
        <WeekCalendar accounts={accounts} />
      </div>
      <div class="lg:w-[340px] xl:w-[380px] shrink-0 flex flex-col gap-4 min-h-0">
        <TasksPanel class="lg:flex-[3] min-h-[280px] lg:min-h-0" />
        <AutomationsPanel class="lg:flex-[2] min-h-[200px] lg:min-h-0" />
      </div>
    </div>
  );
}
