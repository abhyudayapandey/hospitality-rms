import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import {
  addDays,
  formatDay,
  formatSpan,
  formatTime,
  hoursBetween,
  localDate,
  localToday,
  localToInstant,
} from '@/lib/dates';
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
  tabAccess,
  type MyShift,
  upcomingEvents,
  type UpcomingEvent,
} from '@/lib/people';
import {
  formatDuration,
  inOutLabel,
  endsNextDay,
  isFlagged,
  nextShift,
  rowTitle,
  weekStrip,
  statusLabel,
  type TimelineRow,
} from '@/lib/timeline';
import { jobTitles } from '@/lib/job-titles';
import { companySettings } from '@/lib/settings-data';
import { canOfferSwap } from '@/lib/roster-view';

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
      settings: await companySettings(tx),
      // the next 7 days' events where they work: Events itself is on the Team side
      events: ctx.can('EVENTS')
        ? await upcomingEvents(
            tx,
            localToInstant(today, '00:00', ctx.tz),
            localToInstant(addDays(today, 7), '00:00', ctx.tz),
          )
        : [],
    };
  });
  // SW-4: with swaps for management only, staff see no Swap button (the database refuses too)
  const canSwap = canOfferSwap(tabAccess(ctx), data.settings.swaps_managers_only);
  const swaps = new Map(data.shifts.map((s) => [s.shift_id, s]));
  const hours = data.shifts
    .filter((s) => s.local_date < addDays(today, 7))
    .reduce((n, s) => n + hoursBetween(s.start_at, s.end_at), 0);
  const sections: [string, string, TimelineRow[]][] = [
    ['today', 'Today', data.timeline.filter((r) => r.local_date === today)],
    ['upcoming', 'Upcoming', data.timeline.filter((r) => r.local_date > today)],
    ['past', 'Past 14 days', data.timeline.filter((r) => r.local_date < today)],
  ];
  const next = nextShift(data.timeline, today);
  const strip = weekStrip(data.timeline, today, ctx.tz);
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
          {next && (
            <section
              aria-label="Your next shift"
              className="space-y-1 rounded-2xl bg-brand-700 p-4 text-white"
              data-testid="next-shift"
            >
              <p className="text-sm text-brand-100">
                Your next shift ·{' '}
                {next.local_date === today
                  ? 'Today'
                  : next.local_date === addDays(today, 1)
                    ? 'Tomorrow'
                    : formatDay(next.local_date)}
              </p>
              <p className="text-2xl font-bold tabular-nums">
                {formatTime(next.shift_start!, ctx.tz)}–{formatTime(next.shift_end!, ctx.tz)}
              </p>
              <p className="text-sm text-brand-100">
                {[
                  next.role_code ? title(next.role_code) : null,
                  next.place_name,
                  endsNextDay(next, ctx.tz),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </section>
          )}
          <ol
            className="grid grid-cols-7 gap-1 text-center text-xs"
            aria-label="The next seven days"
            data-testid="week-strip"
          >
            {strip.map((c) => (
              <li
                key={c.date}
                className={`rounded-lg py-2 ring-1 ${
                  c.start ? 'bg-white ring-slate-300' : 'bg-slate-50 text-slate-400 ring-slate-200'
                } ${c.today ? 'ring-2 ring-sky-400' : ''}`}
              >
                <span className="block font-medium">{c.day}</span>
                <span className="block tabular-nums">{c.start ?? 'off'}</span>
              </li>
            ))}
          </ol>
          <p className="text-sm text-slate-600">
            {data.worker.node_name} · {title(data.worker.role_code)} · {hours} h in the next 7 days
          </p>
          {data.events.length > 0 && <EventsThisWeek events={data.events} tz={ctx.tz} />}
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
                    {(() => {
                      const days = key === 'past' ? groupByDay(rows).reverse() : groupByDay(rows);
                      // beyond a week, the rest of the upcoming shifts wait behind a tap
                      const later =
                        key === 'upcoming' ? days.filter(([d]) => d > addDays(today, 7)) : [];
                      const soon = days.filter(([d]) => !later.some(([l]) => l === d));
                      const day = ([d, dayRows]: [string, TimelineRow[]]) => (
                        <div
                          key={d}
                          data-testid="shift-day"
                          data-today={d === today ? 'true' : undefined}
                          className={`space-y-1 rounded-xl p-2 ${d === today ? 'bg-sky-50 ring-2 ring-sky-300' : ''}`}
                        >
                          <p className="px-2 text-sm font-medium">
                            {d === today ? `Today, ${formatDay(d)}` : formatDay(d)}
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
                                canSwap={canSwap}
                              />
                            ))}
                          </ul>
                        </div>
                      );
                      return (
                        <>
                          {soon.map(day)}
                          {later.length > 0 && (
                            <details data-testid="shifts-later">
                              <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-slate-700 underline">
                                Later: {later.length} more {later.length === 1 ? 'day' : 'days'}
                              </summary>
                              <div className="space-y-2 pt-1">{later.map(day)}</div>
                            </details>
                          )}
                        </>
                      );
                    })()}
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
        {endsNextDay(row, tz) && (
          <span className="block text-xs text-slate-500">{endsNextDay(row, tz)}</span>
        )}
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
            Swap {swap.open_swap === 'proposed' ? 'offered' : 'waiting for approval'}
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

function EventsThisWeek({ events, tz }: { events: UpcomingEvent[]; tz: string }) {
  return (
    <section className="space-y-2" data-testid="events-this-week">
      <h2 className="text-sm font-semibold text-slate-500">Events this week</h2>
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {events.map((e) => (
          <li key={e.id}>
            <Link
              href={`/events/${e.id}?node=${e.org_node_id}`}
              className="flex min-h-12 items-center justify-between gap-2 px-4 py-2"
            >
              <span>
                <span className="block text-sm font-medium">{e.name}</span>
                <span className="text-xs text-slate-500 tabular-nums">
                  {formatDay(localDate(e.starts_at, tz))} · {formatSpan(e.starts_at, e.ends_at, tz)}{' '}
                  · {e.place_name}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs text-slate-600">
                <span className="block text-base font-semibold tabular-nums">{e.covers}</span>
                covers
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
