import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay, formatSpan, formatTime, hoursBetween, localToday } from '@/lib/dates';
import { withUser } from '@/lib/db';
import type { SearchParams } from '@/lib/inventory';
import {
  EXCEPTION_LABEL,
  myExceptions,
  myShifts,
  myWorker,
  openPunch,
  peopleContext,
} from '@/lib/people';

// My shifts: the next six weeks of published shifts, with swap offers and the clock state,
// and the person's own attendance exceptions of the last two weeks (audit #10).
export default async function MyShiftsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  const user = await requireUser();
  const today = localToday(ctx.tz);
  const data = await withUser(user.id, async (tx) => ({
    worker: await myWorker(tx),
    shifts: await myShifts(tx, today, 42),
    punch: await openPunch(tx),
    flags: await myExceptions(tx, addDays(today, -14)),
  }));
  const hours = data.shifts
    .filter((s) => s.local_date < addDays(today, 7))
    .reduce((n, s) => n + hoursBetween(s.start_at, s.end_at), 0);
  return (
    <div className="space-y-4">
      <PollRefresh />
      <PeopleHeader ctx={ctx} active="/roster/my" title="My shifts" />
      {!data.worker ? (
        <Empty>You are not set up as a worker, so you have no shifts.</Empty>
      ) : (
        <>
          <Link
            href="/roster/clock"
            className="flex min-h-16 items-center justify-between rounded-xl bg-white p-4 ring-1 ring-slate-200"
            data-testid="clock-card"
          >
            <span>
              <span className="block font-medium">
                {data.punch ? 'Clocked in' : 'Not clocked in'}
              </span>
              <span className="text-sm text-slate-600">
                {data.punch
                  ? `since ${formatTime(data.punch.clock_in_at, ctx.tz)}`
                  : 'Tap to clock in'}
              </span>
            </span>
            <span aria-hidden className="text-2xl">
              ⏱
            </span>
          </Link>
          <p className="text-sm text-slate-600">
            {data.worker.node_name} · {data.worker.role_code.toLowerCase()} · {hours} h in the next
            7 days
          </p>
          {data.flags.length > 0 && (
            <section className="space-y-2" data-testid="my-exceptions">
              <h2 className="text-sm font-semibold text-slate-500">Attendance flags</h2>
              <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                {data.flags.map((f) => (
                  <li key={f.id} className="flex justify-between gap-2 px-4 py-3 text-sm">
                    <span>
                      <span className="block font-medium">{EXCEPTION_LABEL[f.kind] ?? f.kind}</span>
                      <span className="text-xs text-slate-500">{formatDay(f.local_date)}</span>
                    </span>
                    <span className="text-right text-xs text-slate-600">
                      {f.status === 'open' ? 'Waiting for review' : 'Reviewed'}
                      {f.resolution_note && (
                        <span className="block text-slate-500">{f.resolution_note}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.shifts.length === 0 ? (
            <Empty>No published shifts in the next six weeks.</Empty>
          ) : (
            <ul className="space-y-2" data-testid="my-shifts">
              {data.shifts.map((s) => (
                <li
                  key={s.assignment_id}
                  className="flex items-center justify-between gap-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <span>
                    <span className="block font-medium">
                      {s.local_date === today ? 'Today' : formatDay(s.local_date)}
                    </span>
                    <span className="text-sm text-slate-600 tabular-nums">
                      {formatSpan(s.start_at, s.end_at, ctx.tz)} · {s.role_code.toLowerCase()}
                    </span>
                  </span>
                  {s.open_swap ? (
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800">
                      Swap {s.open_swap === 'proposed' ? 'offered' : 'awaiting approval'}
                    </span>
                  ) : new Date(s.start_at) > new Date() && ctx.can('SHIFT_SWAPS', 'modify') ? (
                    <Link
                      href={`/roster/swaps/new?assignment=${s.assignment_id}`}
                      className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ring-1 ring-slate-300"
                    >
                      Swap
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
