import Link from 'next/link';
import { TasksHeader } from '@/components/tasks-header';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { assignablePeople, checklist, jobRolesAt, taskTabs } from '@/lib/tasks';
import { describeSchedule } from '@/lib/tasks-view';
import { newerLibraryVersion, type LibraryStep } from '@outlet-ops/domain';
import { StatusBox } from '@/components/messages';
import type { StepInput } from '@/lib/tasks-view';
import { ChecklistForm } from '../checklist-form';
import { LibraryUpdate, type StepLine } from './library-update';

const range = (s: {
  kind: string;
  min?: number | null;
  max?: number | null;
  unit?: string | null;
}) =>
  s.kind === 'number' && (s.min != null || s.max != null)
    ? `${s.min ?? '…'} to ${s.max ?? '…'}${s.unit ? ` ${s.unit}` : ''}`
    : null;
const lines = (steps: readonly (StepInput | LibraryStep)[]): StepLine[] =>
  steps.map((s) => ({ label: s.label, range: range(s) }));

export default async function ChecklistPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ updated?: string }>;
}) {
  const { id } = await params;
  const { updated } = await searchParams;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const c = await checklist(tx, id);
    const canEdit =
      c !== null &&
      (
        await sql<{ v: boolean }>`
          select core.can('CHECKLIST_TEMPLATES', 'modify', ${c.org_node_id}::uuid, null) as v`.execute(
          tx,
        )
      ).rows[0]!.v;
    return {
      tabs: await taskTabs(tx),
      c,
      canEdit,
      people: canEdit ? await assignablePeople(tx, c.org_node_id) : [],
      roles: canEdit ? await jobRolesAt(tx, c.org_node_id) : [],
    };
  });
  const c = data.c;
  return (
    <div className="space-y-4">
      <TasksHeader tabs={data.tabs} active="/tasks/checklists" title={c?.name ?? 'Checklist'} />
      <Link href="/tasks/checklists" className="text-sm text-slate-600 underline">
        All checklists
      </Link>
      {!c ? (
        <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
          We couldn&apos;t find that checklist.
        </p>
      ) : data.canEdit ? (
        <>
          <StatusBox
            message={
              updated
                ? 'Updated to the new version. Its name, schedule and who it goes to stay.'
                : null
            }
          />
          {(() => {
            const lib = newerLibraryVersion(c.library_code, c.library_version);
            return (
              lib &&
              !c.archived_at && (
                <LibraryUpdate
                  id={c.id}
                  name={c.name}
                  current={lines(c.steps)}
                  next={lines(lib.steps)}
                />
              )
            );
          })()}
          <ChecklistForm
            node={c.org_node_id}
            people={data.people}
            roles={data.roles}
            existing={c}
          />
        </>
      ) : (
        <section className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200">
          <p className="text-sm text-slate-600">
            {c.place_name} · {describeSchedule(c.schedule)}
            {c.archived_at && ' · stopped'}
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {c.steps.map((s, i) => (
              <li key={i}>
                {s.label}
                {s.kind === 'number' && (s.min != null || s.max != null) && (
                  <span className="text-slate-500">
                    {' '}
                    ({s.min ?? '…'} to {s.max ?? '…'}
                    {s.unit ? ` ${s.unit}` : ''})
                  </span>
                )}
                {s.kind === 'photo' && <span className="text-slate-500"> (photo)</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
