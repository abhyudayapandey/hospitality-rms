import Link from 'next/link';
import { Empty } from '@/components/messages';
import { TasksHeader } from '@/components/tasks-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { placesFor } from '@/lib/places';
import type { SearchParams } from '@/lib/params';
import { checklists, taskTabs } from '@/lib/tasks';
import { describeSchedule } from '@/lib/tasks-view';

// Checklist templates (ADR 020): recurring rounds at the place and below. Department heads
// and outlet managers edit them; supervisors read them. The tasks job creates each round.
export default async function ChecklistsPage({ searchParams }: { searchParams: SearchParams }) {
  const { places, place } = await placesFor('checklists', searchParams);
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => ({
    tabs: await taskTabs(tx),
    list: place ? await checklists(tx, place.id) : [],
    canEdit: place
      ? (
          await sql<{ v: boolean }>`
            select core.can('CHECKLIST_TEMPLATES', 'modify', ${place.id}::uuid, null) as v`.execute(
            tx,
          )
        ).rows[0]!.v
      : false,
  }));
  const active = data.list.filter((c) => !c.archived_at);
  const stopped = data.list.filter((c) => c.archived_at);
  return (
    <div className="space-y-4">
      <TasksHeader
        tabs={data.tabs}
        active="/tasks/checklists"
        title="Checklists"
        switcher={
          place
            ? {
                screen: 'checklists',
                places: places.map((p) => ({ id: p.id, name: p.name })),
                current: place.id,
              }
            : undefined
        }
      />
      {!place ? (
        <Empty>You don&apos;t see checklists anywhere.</Empty>
      ) : (
        <>
          {data.canEdit && (
            <Link
              href={`/tasks/checklists/new?node=${place.id}`}
              className="flex min-h-12 items-center justify-center rounded-xl bg-slate-900 font-medium text-white"
            >
              New checklist
            </Link>
          )}
          {active.length === 0 ? (
            <Empty>No checklists here yet.</Empty>
          ) : (
            <ul
              data-testid="checklists"
              className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            >
              {active.map((c) => (
                <li key={c.id}>
                  <Link href={`/tasks/checklists/${c.id}`} className="block min-h-14 px-4 py-3">
                    <span className="block font-medium">{c.name}</span>
                    <span className="block text-xs text-slate-500">
                      {c.place_name} · {describeSchedule(c.schedule)} · {c.steps.length} step
                      {c.steps.length === 1 ? '' : 's'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {stopped.length > 0 && (
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer content-center text-slate-600">
                Stopped ({stopped.length})
              </summary>
              <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                {stopped.map((c) => (
                  <li key={c.id}>
                    <Link href={`/tasks/checklists/${c.id}`} className="block px-4 py-3">
                      {c.name} · {c.place_name}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
