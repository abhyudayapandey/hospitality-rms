import Link from 'next/link';
import { messageFor, type ErrorCode, ERROR_MESSAGES } from '@outlet-ops/domain';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan } from '@/lib/dates';
import { sql, withUser } from '@/lib/db';
import { isUuid, type SearchParams } from '@/lib/inventory';
import { candidates, peopleContext } from '@/lib/people';
import { warningPhrase } from '@/lib/roster-warnings';
import { AssignButton } from './assign-button';
import { jobTitles } from '@/lib/job-titles';

// Assign a shift: every worker at the node with the shift's role, assignable ones first.
// Rest and weekly hours are warnings: shown, with "Assign anyway" (ADR 019). Any other
// rule they would break is shown instead of the button (hr.assign_candidates).
export default async function ShiftPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) return <Empty>Not found.</Empty>;
  const ctx = await peopleContext(searchParams, 'roster');
  if (!ctx.can('ROSTER', 'modify')) return <Empty>You can&apos;t change the roster.</Empty>;
  const user = await requireUser();
  const title = await withUser(user.id, jobTitles);
  const data = await withUser(user.id, async (tx) => {
    const s = await sql<{
      org_node_id: string;
      local_date: string;
      start_at: Date;
      end_at: Date;
      role_code: string;
      headcount: number;
      filled: number;
    }>`
      select s.org_node_id, s.local_date::text as local_date, s.start_at, s.end_at, s.role_code,
             s.headcount,
             (select count(*)::int from hr.shift_assignment a
               where a.shift_id = s.id and a.status = 'assigned') as filled
        from hr.shift s where s.id = ${id}::uuid`.execute(tx);
    if (!s.rows[0]) return null;
    return { shift: s.rows[0], people: await candidates(tx, id) };
  });
  if (!data) return <Empty>Shift not found.</Empty>;
  const { shift, people } = data;
  const back = `/roster/week?node=${shift.org_node_id}&week=${shift.local_date}&day=${shift.local_date}`;
  const full = shift.filled >= shift.headcount;
  const reason = (code: string) =>
    code in ERROR_MESSAGES ? messageFor(code as ErrorCode) : 'Not available';
  return (
    <div className="space-y-4">
      <Link href={back} className="text-sm text-slate-600">
        ← Week
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold">{formatDay(shift.local_date)}</h1>
        <p className="text-sm text-slate-600 tabular-nums">
          {formatSpan(shift.start_at, shift.end_at, ctx.tz)} · {title(shift.role_code)} ·{' '}
          {shift.filled}/{shift.headcount} filled
        </p>
      </div>
      {people.length === 0 ? (
        <Empty>No other {title(shift.role_code)} works here.</Empty>
      ) : (
        <ul className="space-y-2" data-testid="candidates">
          {people.map((p) => (
            <li
              key={p.worker_id}
              className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200"
            >
              <span>
                <span className="block font-medium">{p.display_name}</span>
                <span className={`text-xs ${p.violation ? 'text-rose-700' : 'text-slate-500'}`}>
                  {p.violation ? reason(p.violation) : `${p.week_hours} h this week`}
                </span>
                {!p.violation &&
                  p.warnings.map((w) => (
                    <span
                      key={w.code}
                      data-testid="candidate-warning"
                      className="block text-xs text-amber-800"
                    >
                      {warningPhrase(w.detail)}
                    </span>
                  ))}
              </span>
              {!p.violation && !full && (
                <AssignButton
                  shift={id}
                  worker={p.worker_id}
                  back={back}
                  accept={p.warnings.map((w) => w.code)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
