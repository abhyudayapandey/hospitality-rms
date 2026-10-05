import Link from 'next/link';
import { Empty } from '@/components/messages';
import { TasksHeader } from '@/components/tasks-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { maintenanceList, myTasks, taskTabs } from '@/lib/tasks';
import { GROUP_TITLES, groupTasks, type TaskGroup } from '@/lib/tasks-view';
import { TaskList } from './task-list';

// My tasks (ADR 020): one-off tasks, checklist rounds, prep and expired batches that are
// mine or my job role's or my shift's, overdue first; and maintenance assigned to me.
export default async function MyTasksPage() {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const tasks = await myTasks(tx);
    const tabs = await taskTabs(tx);
    const fixes = tabs.maintenance
      ? (await maintenanceList(tx)).filter((r) => r.assigned_to === user.id && r.status !== 'done')
      : [];
    return { tasks, tabs, fixes };
  });
  const groups = groupTasks(data.tasks);
  const order: TaskGroup[] = ['overdue', 'today', 'upcoming', 'done'];

  return (
    <div className="space-y-4">
      <PollRefresh />
      <TasksHeader tabs={data.tabs} active="/tasks" title="Tasks" />
      {data.fixes.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">Repairs for you</h2>
          <ul
            data-testid="my-repairs"
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
          >
            {data.fixes.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/tasks/maintenance/${r.id}`}
                  className="flex min-h-14 items-center justify-between gap-2 px-4 py-3"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.title}</span>
                    <span className="block truncate text-xs text-slate-500">{r.place_name}</span>
                  </span>
                  <span className="text-xs text-slate-600">{r.status.replace('_', ' ')}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.tasks.length === 0 ? (
        <Empty>No tasks for you right now.</Empty>
      ) : (
        order
          .filter((g) => groups[g].length > 0)
          .map((g) => (
            <section key={g} className="space-y-2">
              <h2
                className={`text-sm font-semibold ${g === 'overdue' ? 'text-rose-700' : 'text-slate-500'}`}
              >
                {GROUP_TITLES[g]}
              </h2>
              <TaskList tasks={groups[g]} testId={`tasks-${g}`} />
            </section>
          ))
      )}
      {/* the list first, then what to do (ADR 051) */}
      <div className="grid grid-cols-2 gap-2">
        {data.tabs.create && (
          <Link
            href="/tasks/new"
            className="flex min-h-12 items-center justify-center rounded-xl bg-brand-700 font-medium text-white"
          >
            New task
          </Link>
        )}
        {data.tabs.maintenance && (
          <Link
            href="/tasks/maintenance/new"
            className="flex min-h-12 items-center justify-center rounded-xl bg-white font-medium ring-1 ring-slate-300"
          >
            Report a problem
          </Link>
        )}
      </div>
    </div>
  );
}
