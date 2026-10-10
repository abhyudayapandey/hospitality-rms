import { BackLink } from '@/components/back-link';
import { Icon } from '@/components/icon';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { photosEnabled } from '@/lib/photos';
import { assignablePeople, maintenanceRequest } from '@/lib/tasks';
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
      people: canAssign && r.status !== 'done' ? await assignablePeople(tx, r.org_node_id) : [],
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
            History, open for those who assign it (ADR 098) */}
        <p className="text-sm text-slate-600">
          {r.place_name} · from {r.reported_by_name}
        </p>
        {r.description && <p className="text-sm whitespace-pre-line">{r.description}</p>}
        {r.photo_key && <p className="text-xs text-slate-500">Photo added</p>}
        {r.done_note && <p className="text-sm">Fix: {r.done_note}</p>}
        <details
          className="rounded-xl bg-white text-sm ring-1 ring-slate-200"
          open={!mine && data.canAssign}
        >
          <summary className="flex min-h-11 cursor-pointer items-center px-4 font-medium text-slate-600">
            History
          </summary>
          <div className="space-y-1 px-4 pb-3 text-slate-600">
            <p>Reported {formatWhen(r.created_at)}</p>
            <p data-testid="repair-status">
              Handled by {r.handled_by} ·{' '}
              {r.status === 'open'
                ? 'not assigned yet'
                : r.status === 'done'
                  ? `done${r.done_at ? ` ${formatWhen(r.done_at)}` : ''}`
                  : `${r.status === 'in_progress' ? 'in progress' : 'assigned'} with ${r.assigned_to_name}`}
            </p>
            {r.assigned_at && r.assigned_to_name && (
              <p data-testid="repair-given">
                Given to {r.assigned_to_name}
                {r.assigned_by_name && ` by ${r.assigned_by_name}`} {formatWhen(r.assigned_at)}
              </p>
            )}
          </div>
        </details>
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
