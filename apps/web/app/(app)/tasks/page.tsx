import Link from 'next/link';
import { Icon } from '@/components/icon';
import { Empty } from '@/components/messages';
import { TasksHeader } from '@/components/tasks-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { maintenanceList, myHandedOn, myTasks, taskTabs } from '@/lib/tasks';
import { GROUP_TITLES, doneBy, doneLately, groupTasks, myTaskWho } from '@/lib/tasks-view';
import { TaskList } from './task-list';

// My tasks (ADR 020): one-off tasks, checklist rounds, prep and expired batches that are
// mine or my job role's or my shift's, overdue first; and maintenance assigned to me. Each
// says who has it and when it reached them; what I gave to someone else stays in view under
// "Given to others" (ADR 074). What is done stays, under Done, saying who did it and when,
// that business day and the next (ADR 075).
export default async function MyTasksPage() {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const tasks = (await myTasks(tx)).map((t) => ({
      ...t,
      who: doneBy(t) ?? myTaskWho(t),
      given: t.status === 'done' ? null : t.assigned_at,
    }));
    const given = await myHandedOn(tx);
    const tabs = await taskTabs(tx);
    const fixes = tabs.maintenance
      ? (await maintenanceList(tx))
          .filter(
            (r) => r.assigned_to === user.id && (r.status !== 'done' || doneLately(r.done_at)),
          )
          .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done'))
      : [];
    return { tasks, given, tabs, fixes };
  });
  const groups = groupTasks(data.tasks);

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
                    {r.status === 'done' && r.done_at ? (
                      <span
                        className="block truncate text-xs text-slate-500"
                        data-testid="repair-done"
                      >
                        Done by you, {formatWhen(r.done_at)}
                      </span>
                    ) : (
                      r.assigned_at && (
                        <span className="block truncate text-xs text-slate-500">
                          You{r.assigned_by_name && `, from ${r.assigned_by_name}`} · given{' '}
                          {formatWhen(r.assigned_at)}
                        </span>
                      )
                    )}
                  </span>
                  <span
                    className={`text-xs ${r.status === 'done' ? 'text-emerald-700' : 'text-slate-600'}`}
                  >
                    {r.status.replace('_', ' ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.tasks.length === 0 && data.given.length === 0 && (
        <Empty>No tasks for you right now.</Empty>
      )}
      {(['overdue', 'today'] as const)
        .filter((g) => groups[g].length > 0)
        .map((g) => (
          <section key={g} className="space-y-2">
            <h2
              className={`text-sm font-semibold ${g === 'overdue' ? 'text-rose-700' : 'text-slate-500'}`}
            >
              {GROUP_TITLES[g]}
            </h2>
            <TaskList tasks={groups[g]} testId={`tasks-${g}`} mine />
          </section>
        ))}
      {/* what to do next sits under today's work, on the first screen, not under the done
          ones (ADR 098) */}
      <div className="grid grid-cols-2 gap-2">
        {data.tabs.create && (
          <Link
            href="/tasks/new"
            className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-brand-700 font-medium text-white"
          >
            <Icon name="plus" className="size-5" />
            New task
          </Link>
        )}
        {data.tabs.maintenance && (
          <Link
            href="/tasks/maintenance/new"
            className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white font-medium ring-1 ring-slate-300"
          >
            <Icon name="wrench" className="size-5" />
            Report a problem
          </Link>
        )}
      </div>
      {groups.upcoming.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">{GROUP_TITLES.upcoming}</h2>
          <TaskList tasks={groups.upcoming} testId="tasks-upcoming" mine />
        </section>
      )}
      {groups.done.length > 0 && (
        // done ones fold into one row (ADR 098): they stay to be checked, out of the way
        <details className="rounded-xl bg-white ring-1 ring-slate-200" data-testid="done-fold">
          <summary className="flex min-h-14 cursor-pointer items-center gap-3 px-4 font-medium">
            <span className="flex size-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
              <Icon name="check" className="size-6" />
            </span>
            {groups.done.length} done
          </summary>
          <TaskList tasks={groups.done} testId="tasks-done" mine />
        </details>
      )}
      {data.given.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">Given to others</h2>
          <TaskList
            tasks={data.given.map((t) => ({
              ...t,
              priority: 'normal',
              steps_total: 0,
              steps_done: 0,
              who: doneBy(t) ?? t.assignee_name,
              given: t.status === 'done' ? null : t.assigned_at,
            }))}
            testId="tasks-given"
          />
        </section>
      )}
    </div>
  );
}
