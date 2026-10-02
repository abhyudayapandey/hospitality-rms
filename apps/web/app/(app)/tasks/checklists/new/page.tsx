import { TasksHeader } from '@/components/tasks-header';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { placesFor } from '@/lib/places';
import type { SearchParams } from '@/lib/params';
import { assignablePeople, jobRolesAt, taskTabs } from '@/lib/tasks';
import { ChecklistForm } from '../checklist-form';

export default async function NewChecklistPage({ searchParams }: { searchParams: SearchParams }) {
  // places where they may create tasks; save_template checks CHECKLIST_TEMPLATES modify
  const { places, place } = await placesFor('tasks_new', searchParams);
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => ({
    tabs: await taskTabs(tx),
    people: place ? await assignablePeople(tx, place.id) : [],
    roles: place ? await jobRolesAt(tx, place.id) : [],
  }));
  return (
    <div className="space-y-4">
      <TasksHeader
        tabs={data.tabs}
        active="/tasks/checklists"
        title="New checklist"
        switcher={
          place
            ? {
                screen: 'tasks_new',
                places: places.map((p) => ({ id: p.id, name: p.name })),
                current: place.id,
              }
            : undefined
        }
      />
      {place ? (
        <ChecklistForm node={place.id} people={data.people} roles={data.roles} existing={null} />
      ) : (
        <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
          You don&apos;t edit checklists anywhere.
        </p>
      )}
    </div>
  );
}
