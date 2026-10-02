import { TasksHeader } from '@/components/tasks-header';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { placesFor } from '@/lib/places';
import type { SearchParams } from '@/lib/params';
import { assignablePeople, jobRolesAt, taskTabs } from '@/lib/tasks';
import { TaskForm } from './task-form';

// New one-off task (ADR 020) at a place where the person manages tasks: for a person, a
// job role there, or whoever is on shift there when it is due.
export default async function NewTaskPage({ searchParams }: { searchParams: SearchParams }) {
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
        active={null}
        title="New task"
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
        <TaskForm
          node={place.id}
          tz={place.timezone ?? 'Asia/Kolkata'}
          people={data.people}
          roles={data.roles}
        />
      ) : (
        <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
          You don&apos;t give out tasks anywhere.
        </p>
      )}
    </div>
  );
}
