import Link from 'next/link';
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
      <Link href="/tasks/maintenance" className="text-sm text-slate-600 underline">
        All requests
      </Link>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{r.title}</h1>
        <p className="text-sm text-slate-600">
          {r.place_name} · reported by {r.reported_by_name} {formatWhen(r.created_at)}
        </p>
        <p className="text-sm text-slate-600" data-testid="repair-status">
          Handled by {r.handled_by} ·{' '}
          {r.status === 'open'
            ? 'not assigned yet'
            : r.status === 'done'
              ? `done${r.done_at ? ` ${formatWhen(r.done_at)}` : ''}`
              : `${r.status === 'in_progress' ? 'in progress' : 'assigned'} with ${r.assigned_to_name}`}
        </p>
        {r.assigned_at && r.assigned_to_name && (
          <p className="text-sm text-slate-600" data-testid="repair-given">
            Given to {r.assigned_to_name}
            {r.assigned_by_name && ` by ${r.assigned_by_name}`} {formatWhen(r.assigned_at)}
          </p>
        )}
        {r.description && <p className="text-sm whitespace-pre-line">{r.description}</p>}
        {r.photo_key && <p className="text-xs text-slate-500">Photo added</p>}
        {r.done_note && <p className="text-sm">Fix: {r.done_note}</p>}
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
