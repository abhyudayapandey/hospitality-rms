import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay, formatTime, hoursBetween, localToday } from '@/lib/dates';
import { withUser } from '@/lib/db';
import type { SearchParams } from '@/lib/inventory';
import {
  EXCEPTION_LABEL,
  myExceptions,
  type MyException,
  myShifts,
  myTimeline,
  myWorker,
  openPunch,
  peopleContext,
  type MyShift,
} from '@/lib/people';
import {
  formatDuration,
  inOutLabel,
  isFlagged,
  rowTitle,
  statusLabel,
  type TimelineRow,
} from '@/lib/timeline';
import { jobTitles } from '@/lib/job-titles';

// My shifts (ADR 018): the past 14 days and every upcoming published shift (six weeks),
// grouped by day, today first. Past rows show In/Out and a status; time worked outside a
// shift, and unrostered time, are their own rows. Matching and splitting are done by
// hr.my_timeline, the same rule the nightly job and the managers' screen use.

const UPCOMING_DAYS = 42;

function groupByDay(rows: TimelineRow[]): [string, TimelineRow[]][] {
  const days = new Map<string, TimelineRow[]>();
  for (const r of rows) days.set(r.local_date, [...(days.get(r.local_date) ?? []), r]);
  return [...days];
}

export default async function MyShiftsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  const user = await requireUser();
  const title = await withUser(user.id, jobTitles);
  const today = localToday(ctx.tz);
  const data = await withUser(user.id, async (tx) => {
    const worker = await myWorker(tx);
    return {
      worker,
      timeline: worker
        ? await myTimeline(tx, addDays(today, -14), addDays(today, UPCOMING_DAYS))
        : [],
      shifts: await myShifts(tx, today, UPCOMING_DAYS),
      punch: await openPunch(tx),
      flags: await myExceptions(tx, addDays(today, -14)),
    };
  });
  const swaps = new Map(data.shifts.map((s) => [s.shift_id, s]));
  const hours = data.shifts
    .filter((s) => s.local_date < addDays(today, 7))
    .reduce((n, s) => n + hoursBetween(s.start_at, s.end_at), 0);
  const sections: [string, string, TimelineRow[]][] = [
    ['today', 'Today', data.timeline.filter((r) => r.local_date === today)],
    ['upcoming', 'Upcoming', data.timeline.filter((r) => r.local_date > today)],
    ['past', 'Past 14 days', data.timeline.filter((r) => r.local_date < today)],
  ];
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
            {data.worker.node_name} · {title(data.worker.role_code)} · {hours} h in the next 7 days
          </p>
          {data.flags.length > 0 && (
            // the latest flag, with what happens next; earlier ones folded away so a run of
            // seeded or old flags doesn't read like a warning letter (UX U-15)
            <section className="space-y-2" data-testid="my-exceptions">
              <h2 className="text-sm font-semibold text-slate-500">Attendance</h2>
              <p className="text-sm text-slate-600">
                Your manager reviews these. If one is wrong, tell them.
              </p>
              <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                {data.flags.slice(0, 1).map((f) => (
                  <FlagRow key={f.id} f={f} />
                ))}
              </ul>
              {data.flags.length > 1 && (
                <details className="text-sm">
                  <summary className="min-h-11 cursor-pointer py-2 text-slate-600">
                    {data.flags.length - 1} earlier
                  </summary>
                  <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                    {data.flags.slice(1).map((f) => (
                      <FlagRow key={f.id} f={f} />
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
          {data.timeline.length === 0 ? (
            <Empty>No shifts in the last two weeks or the next six.</Empty>
          ) : (
            <div className="space-y-6" data-testid="my-shifts">
              {sections
                .filter(([, , rows]) => rows.length > 0)
                .map(([key, title, rows]) => (
                  <section key={key} data-testid={`my-shifts-${key}`} className="space-y-2">
                    <h2 className="text-sm font-semibold text-slate-500">{title}</h2>
                    {(key === 'past' ? groupByDay(rows).reverse() : groupByDay(rows)).map(
                      ([day, dayRows]) => (
                        <div
                          key={day}
                          data-testid="shift-day"
                          data-today={day === today ? 'true' : undefined}
                          className={`space-y-1 rounded-xl p-2 ${day === today ? 'bg-sky-50 ring-2 ring-sky-300' : ''}`}
                        >
                          <p className="px-2 text-sm font-medium">
                            {day === today ? `Today, ${formatDay(day)}` : formatDay(day)}
                          </p>
                          <ul className="space-y-1">
                            {dayRows.map((r, i) => (
                              <Row
                                key={`${r.kind}-${r.shift_id ?? r.from_at}-${i}`}
                                row={r}
                                tz={ctx.tz}
                                swap={
                                  r.kind === 'shift' && r.status === 'upcoming' && r.shift_id
                                    ? swaps.get(r.shift_id)
                                    : undefined
                                }
                                canSwap={ctx.can('SHIFT_SWAPS', 'modify')}
                              />
                            ))}
                          </ul>
                        </div>
                      ),
                    )}
                  </section>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({
  row,
  tz,
  swap,
  canSwap,
}: {
  row: TimelineRow;
  tz: string;
  swap: MyShift | undefined;
  canSwap: boolean;
}) {
  const status = statusLabel(row);
  const inOut = inOutLabel(row, tz);
  const extra = row.kind !== 'shift';
  return (
    <li
      data-testid="shift-row"
      data-kind={row.kind}
      data-status={row.status ?? ''}
      className={`flex items-end justify-between gap-3 rounded-lg bg-white p-3 ring-1 ${
        isFlagged(row) ? 'ring-amber-300' : 'ring-slate-200'
      }`}
    >
      <span className="min-w-0">
        <span className={`block font-medium tabular-nums ${extra ? 'text-slate-600' : ''}`}>
          {rowTitle(row, tz)}
        </span>
        {row.place_name && !extra && (
          <span className="block text-xs text-slate-500">{row.place_name}</span>
        )}
        {status && (
          <span
            data-testid="shift-status"
            className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs ${
              isFlagged(row) ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-700'
            }`}
          >
            {status}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        {inOut && (
          <span data-testid="shift-in-out" className="block text-xs text-slate-600 tabular-nums">
            {inOut}
          </span>
        )}
        {extra && row.minutes > 0 && (
          <span className="block text-xs text-slate-500">{formatDuration(row.minutes)}</span>
        )}
        {swap?.open_swap ? (
          <span className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800">
            Swap {swap.open_swap === 'proposed' ? 'offered' : 'awaiting approval'}
          </span>
        ) : swap && canSwap ? (
          <Link
            href={`/roster/swaps/new?assignment=${swap.assignment_id}`}
            className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ring-1 ring-slate-300"
          >
            Swap
          </Link>
        ) : null}
      </span>
    </li>
  );
}

function FlagRow({ f }: { f: MyException }) {
  return (
    <li className="flex justify-between gap-2 px-4 py-3 text-sm">
      <span>
        <span className="block font-medium">{EXCEPTION_LABEL[f.kind] ?? f.kind}</span>
        <span className="text-xs text-slate-500">{formatDay(f.local_date)}</span>
      </span>
      <span className="text-right text-xs text-slate-600">
        {f.status === 'open' ? 'Not reviewed yet' : 'Reviewed'}
        {f.resolution_note && <span className="block text-slate-500">{f.resolution_note}</span>}
      </span>
    </li>
  );
}
