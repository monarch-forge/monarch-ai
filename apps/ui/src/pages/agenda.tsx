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
    <div class="h-full p-3 flex gap-3 min-h-0">
      <WeekCalendar accounts={accounts} />
      <div class="w-[360px] xl:w-[400px] shrink-0 flex flex-col gap-3 min-h-0">
        <TasksPanel class="flex-[3] min-h-0" />
        <AutomationsPanel class="flex-[2] min-h-0" />
      </div>
    </div>
  );
}
