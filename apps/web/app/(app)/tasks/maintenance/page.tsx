import Link from 'next/link';
import { Empty } from '@/components/messages';
import { TasksHeader } from '@/components/tasks-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { maintenanceList, taskTabs } from '@/lib/tasks';

const STATUS: Record<string, string> = {
  open: 'open',
  assigned: 'assigned',
  in_progress: 'in progress',
  done: 'done',
};

// Maintenance (ADR 020): requests the person raised, their department's queue (Engineering
// staff), or those they manage. Raised anywhere they work; routed to the outlet's
// Engineering head, else up the tree.
export default async function MaintenancePage() {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => ({
    tabs: await taskTabs(tx),
    list: await maintenanceList(tx),
  }));
  return (
    <div className="space-y-4">
      <PollRefresh />
      <TasksHeader tabs={data.tabs} active="/tasks/maintenance" title="Maintenance" />
      <Link
        href="/tasks/maintenance/new"
        className="flex min-h-12 items-center justify-center rounded-xl bg-slate-900 font-medium text-white"
      >
        Report a problem
      </Link>
      {data.list.length === 0 ? (
        <Empty>No maintenance requests.</Empty>
      ) : (
        <ul
          data-testid="maintenance"
          className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
        >
          {data.list.map((r) => (
            <li key={r.id}>
              <Link
                href={`/tasks/maintenance/${r.id}`}
                className="flex min-h-14 items-center justify-between gap-2 px-4 py-3"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.title}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {r.place_name} · {formatWhen(r.created_at)}
                    {r.assigned_to_name && ` · ${r.assigned_to_name}`}
                  </span>
                </span>
                <span
                  className={`shrink-0 text-xs ${r.status === 'done' ? 'text-emerald-700' : 'text-slate-600'}`}
                >
                  {STATUS[r.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
