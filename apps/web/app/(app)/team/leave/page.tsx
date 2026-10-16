import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay, localToday } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/inventory';
import { Initials } from '@/components/initials';
import { peopleContext, teamLeave, type TeamLeave } from '@/lib/people';

// each state as a pill: waiting, approved, rejected (asked, not approved), cancelled (approved,
// then taken back)
const LEAVE_PILL: Record<TeamLeave['status'], [string, string]> = {
  submitted: ['Waiting', 'bg-amber-50 text-amber-800'],
  approved: ['Approved', 'bg-emerald-50 text-emerald-800'],
  rejected: ['Rejected', 'bg-rose-50 text-rose-800'],
  cancelled: ['Cancelled', 'bg-slate-100 text-slate-700'],
};

// Team → Leave (UX-5, ADR 035, 163): who is off when at the place over the next 30 or 90 days,
// every request with its state (waiting, approved, rejected, cancelled), by day or by person.
// hr.team_leave checks LEAVE view there.
export default async function TeamLeavePage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams, 'team_leave');
  if (!ctx.node) return <Empty>You don&apos;t see anyone&apos;s leave.</Empty>;
  const node = ctx.node;
  const sp = await searchParams;
  const days = param(sp, 'days') === '90' ? 90 : 30;
  const byPerson = param(sp, 'view') === 'person';
  const from = localToday(ctx.tz);
  const to = addDays(from, days);
  const user = await requireUser();
  const rows = await withUser(user.id, (tx) => teamLeave(tx, node.id, from, to));
  return (
    <div className="space-y-4">
      <PeopleHeader ctx={ctx} active="/team/leave" title="Leave" />
      <nav aria-label="Period" className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
        {[30, 90].map((d) => (
          <Link
            key={d}
            href={`/team/leave?node=${node.id}&days=${d}${byPerson ? '&view=person' : ''}`}
            aria-current={d === days ? 'page' : undefined}
            className={`flex min-h-11 items-center justify-center rounded-md text-sm ${
              d === days ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'
            }`}
          >
            Next {d} days
          </Link>
        ))}
      </nav>
      <nav aria-label="Show" className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
        {[
          ['day', 'By day'],
          ['person', 'By person'],
        ].map(([v, label]) => {
          const on = (v === 'person') === byPerson;
          return (
            <Link
              key={v}
              href={`/team/leave?node=${node.id}&days=${days}${v === 'person' ? '&view=person' : ''}`}
              aria-current={on ? 'page' : undefined}
              data-testid={`leave-view-${v}`}
              className={`flex min-h-11 items-center justify-center rounded-md text-sm ${
                on ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      {rows.length === 0 ? (
        <Empty>Nobody is on leave in the next {days} days.</Empty>
      ) : (
        <ul
          className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
          data-testid="team-leave"
        >
          {(byPerson
            ? [...rows].sort(
                (a, b) => a.name.localeCompare(b.name) || a.from_date.localeCompare(b.from_date),
              )
            : rows
          ).map((r, i, list) => (
            <li key={r.leave_id} data-testid="leave-row" data-status={r.status}>
              {byPerson && (i === 0 || list[i - 1]!.worker_id !== r.worker_id) && (
                <p
                  className="flex items-center gap-2 bg-slate-100 px-4 py-2 font-semibold text-slate-900"
                  data-testid="leave-person"
                >
                  <Initials name={r.name} className="size-7 text-xs" />
                  {r.name}
                  <span className="text-xs font-normal text-slate-500">{r.job_role}</span>
                </p>
              )}
              <Link
                href={`/leave/${r.leave_id}`}
                className="flex items-start justify-between gap-3 px-4 py-3"
              >
                {!byPerson && <Initials name={r.name} />}
                <span className="min-w-0 flex-1">
                  {!byPerson && (
                    <>
                      <span className="block font-medium">{r.name}</span>
                      <span className="block text-xs text-slate-500">
                        {r.job_role} · {r.place}
                      </span>
                    </>
                  )}
                  <span className="block text-sm">
                    {r.from_date === r.to_date
                      ? formatDay(r.from_date)
                      : `${formatDay(r.from_date)} to ${formatDay(r.to_date)}`}{' '}
                    · {r.leave_type} · {Number(r.days)} {Number(r.days) === 1 ? 'day' : 'days'}
                  </span>
                  <span className="block text-xs text-slate-600" data-testid="leave-words">
                    {r.words}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${LEAVE_PILL[r.status][1]}`}
                >
                  {LEAVE_PILL[r.status][0]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
