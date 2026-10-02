import { Empty } from '@/components/messages';
import { TasksHeader } from '@/components/tasks-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { placesFor } from '@/lib/places';
import type { SearchParams } from '@/lib/params';
import { assignablePeople, jobRolesAt, prepSuggestions, taskTabs } from '@/lib/tasks';
import { PrepForm } from './prep-form';

// Prep list (ADR 020): for each item made at the store, its par, what is on hand and not
// expired, what events in the next 48 hours need and what open prep tasks will still make;
// the suggestion is par plus event needs minus the rest. Chosen lines become prep tasks for
// the team that makes things there; each is done by recording the batch.
export default async function PrepPage({ searchParams }: { searchParams: SearchParams }) {
  const { places, place } = await placesFor('production', searchParams);
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const tabs = await taskTabs(tx);
    if (!place) return { tabs, lines: [], team: null, people: [], roles: [], canCreate: false };
    const lines = await prepSuggestions(tx, place.id);
    const t = await sql<{ team: string | null; ok: boolean }>`
      select ops.team_of_store(${place.id}::uuid) as team,
             coalesce(core.can('TASKS', 'modify', ops.team_of_store(${place.id}::uuid), null), false)
               as ok`.execute(tx);
    const team = t.rows[0]?.team ?? null;
    const canCreate = Boolean(team && t.rows[0]?.ok);
    return {
      tabs,
      lines,
      team,
      canCreate,
      people: canCreate && team ? await assignablePeople(tx, team) : [],
      roles: canCreate && team ? await jobRolesAt(tx, team) : [],
    };
  });
  return (
    <div className="space-y-4">
      <TasksHeader
        tabs={data.tabs}
        active="/tasks/prep"
        title="Prep list"
        switcher={
          place
            ? {
                screen: 'production',
                places: places.map((p) => ({ id: p.id, name: p.name })),
                current: place.id,
              }
            : undefined
        }
      />
      {!place || data.lines.length === 0 ? (
        <Empty>Nothing is made at this store.</Empty>
      ) : (
        <PrepForm
          store={place.id}
          tz={place.timezone ?? 'Asia/Kolkata'}
          lines={data.lines}
          canCreate={data.canCreate}
          people={data.people}
          roles={data.roles}
        />
      )}
    </div>
  );
}
