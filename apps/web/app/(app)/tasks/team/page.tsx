import { Empty } from '@/components/messages';
import { TasksHeader } from '@/components/tasks-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { addDays, localDate, localToday, weekStart } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { placesFor } from '@/lib/places';
import type { SearchParams } from '@/lib/params';
import { completion, taskTabs, teamTasks, type Completion } from '@/lib/tasks';
import { TaskList } from '../task-list';

// Team tasks (ADR 020): today's tasks at the place and below, with who has them and their
// progress; anything overdue from the past week; and completion per department this week
// and last week (tasks due so far, done, and done on time).
export default async function TeamTasksPage({ searchParams }: { searchParams: SearchParams }) {
  const { places, place } = await placesFor('tasks', searchParams);
  const user = await requireUser();
  const tz = place?.timezone ?? 'Asia/Kolkata';
  const today = localToday(tz);
  const thisWeek = weekStart(today);
  const data = await withUser(user.id, async (tx) => ({
    tabs: await taskTabs(tx),
    tasks: place ? await teamTasks(tx, place.id, addDays(today, -7), today) : [],
    now: place ? await completion(tx, place.id, thisWeek) : [],
    last: place ? await completion(tx, place.id, addDays(thisWeek, -7)) : [],
  }));
  const todays = data.tasks.filter((t) => !t.overdue && localDate(t.due_at, tz) === today);
  const overdue = data.tasks.filter((t) => t.overdue);
  const listed = (ts: typeof data.tasks) =>
    ts.map((t) => ({ ...t, who: t.assignee_name ?? t.pool, flagged: t.flagged }));

  return (
    <div className="space-y-4">
      <PollRefresh />
      <TasksHeader
        tabs={data.tabs}
        active="/tasks/team"
        title="Team tasks"
        switcher={
          place
            ? {
                screen: 'tasks',
                places: places.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
                current: place.id,
              }
            : undefined
        }
      />
      {!place ? (
        <Empty>You don&apos;t see a team&apos;s tasks anywhere.</Empty>
      ) : (
        <>
          <CompletionTable now={data.now} last={data.last} />
          {overdue.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-rose-700">Overdue</h2>
              <TaskList tasks={listed(overdue)} testId="team-overdue" />
            </section>
          )}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-500">Today</h2>
            {todays.length === 0 ? (
              <Empty>Nothing due today.</Empty>
            ) : (
              <TaskList tasks={listed(todays)} testId="team-today" />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function CompletionTable({ now, last }: { now: Completion[]; last: Completion[] }) {
  const rows = now.filter(
    (r) => r.due > 0 || last.some((l) => l.org_node_id === r.org_node_id && l.due > 0),
  );
  const pct = (r: Completion | undefined) =>
    r?.pct === null || r === undefined ? '–' : `${r.pct}%`;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-500">Done so far, by department</h2>
      {rows.length === 0 ? (
        <Empty>No tasks were due this week or last.</Empty>
      ) : (
        <table
          className="w-full rounded-xl bg-white text-sm ring-1 ring-slate-200"
          data-testid="completion"
        >
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="px-3 py-2 font-medium">Department</th>
              <th className="px-3 py-2 text-right font-medium">This week</th>
              <th className="px-3 py-2 text-right font-medium">Last week</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const l = last.find((x) => x.org_node_id === r.org_node_id);
              return (
                <tr key={r.org_node_id}>
                  <td className="px-3 py-2">{r.place_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {pct(r)}
                    <span className="block text-xs text-slate-500">
                      {r.done} of {r.due}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {pct(l)}
                    {l && (
                      <span className="block text-xs text-slate-500">
                        {l.done} of {l.due}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
