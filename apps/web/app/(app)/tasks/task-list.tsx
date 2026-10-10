import Link from 'next/link';
import { taskIcon } from '@outlet-ops/domain';
import { Icon } from '@/components/icon';
import { formatWhen } from '@/lib/format';
import { overdueWhenGiven, progress } from '@/lib/tasks-view';

export interface ListedTask {
  id: string;
  title: string;
  /** for its picture (ADR 079) */
  kind?: string;
  place_name: string;
  due_at: Date;
  priority: string;
  status: string;
  overdue: boolean;
  steps_total: number;
  steps_done: number;
  /** who has it ("You" when it is the reader's own; null: nobody has taken it yet) */
  who?: string | null;
  /** when it reached them (ADR 074) */
  given?: Date | null;
  /** the job role whose work it is, when it came to me by cover (ADR 061) */
  covering?: string | null;
  flagged?: number;
}

const STATUS: Record<string, string> = {
  reported: 'to assign',
  open: 'to do',
  in_progress: 'started',
  done: 'done',
  cancelled: 'cancelled',
};

/**
 * A list of tasks. `mine`: the reader's own To do list (ADR 098), one line a task: its
 * picture, its title, when it is due and a red dot when late; who gave it and when are on the
 * task's History. Lists of other people's tasks say who has it, since when, and where.
 */
export function TaskList({
  tasks,
  testId,
  mine = false,
}: {
  tasks: ListedTask[];
  testId?: string;
  mine?: boolean;
}) {
  return (
    <ul
      data-testid={testId}
      className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
    >
      {tasks.map((t) => {
        const p = progress(t.steps_done, t.steps_total);
        return (
          <li key={t.id}>
            <Link
              href={`/tasks/${t.id}`}
              className="flex min-h-14 items-center justify-between gap-3 px-4 py-3"
            >
              <span
                className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"
                data-testid="task-icon"
                data-icon={taskIcon(t.title, t.kind ?? 'one_off')}
              >
                <Icon name={taskIcon(t.title, t.kind ?? 'one_off')} className="size-7" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{t.title}</span>
                {t.covering && (
                  <span
                    data-testid="task-covering"
                    className="block truncate text-xs text-slate-600"
                  >
                    {t.covering}&rsquo;s work (you&rsquo;re covering)
                  </span>
                )}
                {!mine && (
                  <span className="block truncate text-xs text-slate-500">
                    {t.place_name} · due {formatWhen(t.due_at)}
                  </span>
                )}
                {(!mine || t.status === 'done') && (t.who !== undefined || t.given) && (
                  <span className="block truncate text-xs text-slate-500" data-testid="task-who">
                    {t.who !== undefined ? (t.who ?? 'Not taken yet') : ''}
                    {t.who !== undefined && t.given ? ' · ' : ''}
                    {t.given && `given ${formatWhen(t.given)}`}
                  </span>
                )}
              </span>
              {mine ? (
                // the reader's own: when, and a red dot when late or urgent; done is green
                <span className="flex shrink-0 items-center gap-2 text-sm tabular-nums">
                  {t.status === 'done' ? (
                    <Icon name="check" className="size-5 text-emerald-700" label="Done" />
                  ) : (
                    <>
                      <span
                        className={t.overdue ? 'font-semibold text-rose-700' : 'text-slate-600'}
                      >
                        {t.steps_total > 1 && t.steps_done > 0
                          ? p.text
                          : formatWhen(t.due_at).replace(/^today, /, '')}
                      </span>
                      {(t.overdue || t.priority === 'high') && (
                        <span
                          className="size-2.5 rounded-full bg-rose-600"
                          data-testid="task-late"
                          aria-label={t.overdue ? 'Late' : 'Urgent'}
                        />
                      )}
                    </>
                  )}
                </span>
              ) : (
                <span className="shrink-0 text-right text-xs tabular-nums">
                  <span
                    className={
                      t.overdue
                        ? 'font-semibold text-rose-700'
                        : t.status === 'done'
                          ? 'text-emerald-700'
                          : 'text-slate-600'
                    }
                  >
                    {t.overdue
                      ? overdueWhenGiven(t)
                        ? 'overdue when given'
                        : 'overdue'
                      : (STATUS[t.status] ?? t.status)}
                  </span>
                  {t.steps_total > 1 && <span className="block text-slate-500">{p.text}</span>}
                  {(t.flagged ?? 0) > 0 && (
                    <span className="block font-semibold text-amber-700">{t.flagged} flagged</span>
                  )}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
