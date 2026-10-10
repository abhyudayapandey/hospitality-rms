import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay, localToday } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/inventory';
import { Initials } from '@/components/initials';
import { peopleContext, teamLeave } from '@/lib/people';

// Team → Leave (UX-5, ADR 035): who is off when at the place, waiting and approved, over
// the next 30 or 90 days. hr.team_leave checks LEAVE view there.
export default async function TeamLeavePage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams, 'team_leave');
  if (!ctx.node) return <Empty>You don&apos;t see anyone&apos;s leave.</Empty>;
  const node = ctx.node;
  const days = param(await searchParams, 'days') === '90' ? 90 : 30;
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
            href={`/team/leave?node=${node.id}&days=${d}`}
            aria-current={d === days ? 'page' : undefined}
            className={`flex min-h-11 items-center justify-center rounded-md text-sm ${
              d === days ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'
            }`}
          >
            Next {d} days
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <Empty>Nobody is on leave in the next {days} days.</Empty>
      ) : (
        <ul
          className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
          data-testid="team-leave"
        >
          {rows.map((r) => (
            <li
              key={r.leave_id}
              className="flex items-start justify-between gap-3 px-4 py-3"
              data-testid="leave-row"
            >
              <Initials name={r.name} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{r.name}</span>
                <span className="block text-xs text-slate-500">
                  {r.job_role} · {r.place}
                </span>
                <span className="block text-sm">
                  {r.from_date === r.to_date
                    ? formatDay(r.from_date)
                    : `${formatDay(r.from_date)} to ${formatDay(r.to_date)}`}{' '}
                  · {r.leave_type} · {Number(r.days)} {Number(r.days) === 1 ? 'day' : 'days'}
                </span>
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                  r.status === 'approved'
                    ? 'bg-emerald-50 text-emerald-800'
                    : 'bg-amber-50 text-amber-800'
                }`}
              >
                {r.status === 'approved' ? 'Approved' : 'Waiting'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
