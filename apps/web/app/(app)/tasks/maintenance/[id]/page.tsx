import { maintenanceWhereWord } from '@outlet-ops/domain';
import { BackLink } from '@/components/back-link';
import { Icon } from '@/components/icon';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { photosEnabled } from '@/lib/photos';
import { maintenanceRequest, peopleOnShift } from '@/lib/tasks';
import { AssignRepair, WorkRepair } from '../maintenance-forms';

export default async function MaintenanceRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const r = await maintenanceRequest(tx, id);
    const canAssign =
      r !== null &&
      (
        await sql<{ v: boolean }>`
          select core.can('MAINTENANCE', 'modify', ${r.org_node_id}::uuid, null) as v`.execute(tx)
      ).rows[0]!.v;
    return {
      r,
      canAssign,
      people: canAssign && r.status !== 'done' ? await peopleOnShift(tx, r.org_node_id) : [],
    };
  });
  const r = data.r;
  if (!r) {
    return (
      <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
        We couldn&apos;t find that request.
      </p>
    );
  }
  const mine = r.assigned_to === user.id;
  return (
    <div className="space-y-4">
      <BackLink fallback="/tasks/maintenance" />
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Icon name="wrench" className="size-7 text-brand-700" />
          {r.title}
        </h1>
        {/* one line: where and from whom; who handles it and how it got there are under
            History, always open (ADR 164) */}
        <p className="text-sm text-slate-600">
          {maintenanceWhereWord(r.location) ?? r.place_name} · from {r.reported_by_name}
        </p>
        {r.description && <p className="text-sm whitespace-pre-line">{r.description}</p>}
        {r.photo_key && <p className="text-xs text-slate-500">Photo added</p>}
        {r.done_note && <p className="text-sm">Fix: {r.done_note}</p>}
        <section
          className="rounded-xl bg-white text-sm ring-1 ring-slate-200"
          aria-labelledby="repair-history"
        >
          <h2
            id="repair-history"
            className="flex min-h-11 items-center px-4 font-medium text-slate-600"
          >
            History
          </h2>
          {/* newest first (ADR 142): where it is now, who has it, then when it was reported */}
          <div className="space-y-1 px-4 pb-3 text-slate-600">
            {/* where it is now, a sentence of its own: "With Vinay", never "assigned with" */}
            <p data-testid="repair-status">
              {r.status === 'open'
                ? 'Not assigned yet'
                : r.status === 'done'
                  ? `Done${r.done_at ? ` ${formatWhen(r.done_at)}` : ''}`
                  : r.status === 'in_progress'
                    ? `${r.assigned_to_name} is on it`
                    : `With ${r.assigned_to_name}`}
            </p>
            {r.assigned_at && r.assigned_to_name && (
              <p data-testid="repair-given">
                Given to {r.assigned_to_name}
                {r.assigned_by_name && ` by ${r.assigned_by_name}`} {formatWhen(r.assigned_at)}
              </p>
            )}
            <p>Handled by {r.handled_by}</p>
            <p>Reported {formatWhen(r.created_at)}</p>
          </div>
        </section>
      </header>
      {data.canAssign && (r.status === 'open' || r.status === 'assigned') && (
        <AssignRepair id={r.id} people={data.people} current={r.assigned_to} />
      )}
      {mine && (r.status === 'assigned' || r.status === 'in_progress') && (
        <WorkRepair id={r.id} node={r.org_node_id} status={r.status} photos={photosEnabled()} />
      )}
    </div>
  );
}
