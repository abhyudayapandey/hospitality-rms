import Link from 'next/link';
import { formatWhen } from '@/lib/format';
import { overdueWhenGiven, progress } from '@/lib/tasks-view';

export interface ListedTask {
  id: string;
  title: string;
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

export function TaskList({ tasks, testId }: { tasks: ListedTask[]; testId?: string }) {
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
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {t.priority === 'high' && (
                    <span className="mr-1 text-rose-700" aria-label="High priority">
                      !
                    </span>
                  )}
                  {t.title}
                </span>
                {t.covering && (
                  <span
                    data-testid="task-covering"
                    className="block truncate text-xs text-slate-600"
                  >
                    {t.covering}&rsquo;s work (you&rsquo;re covering)
                  </span>
                )}
                <span className="block truncate text-xs text-slate-500">
                  {t.place_name} · due {formatWhen(t.due_at)}
                </span>
                {(t.who !== undefined || t.given) && (
                  <span className="block truncate text-xs text-slate-500" data-testid="task-who">
                    {t.who !== undefined ? (t.who ?? 'Not taken yet') : ''}
                    {t.who !== undefined && t.given ? ' · ' : ''}
                    {t.given && `given ${formatWhen(t.given)}`}
                  </span>
                )}
              </span>
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
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
