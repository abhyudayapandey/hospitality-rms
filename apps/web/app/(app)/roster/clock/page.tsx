import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay, formatSpan, formatTime, localDate, localToday } from '@/lib/dates';
import { withUser } from '@/lib/db';
import type { SearchParams } from '@/lib/inventory';
import { myShifts, myWorker, openPunch, pastSessions, peopleContext } from '@/lib/people';
import { formatDuration } from '@/lib/timeline';
import { ClockPanel } from './clock-panel';

// Clock in/out. Location is checked against the outlet's geofence in SQL; outside the
// fence or without location the punch is recorded and flagged, never blocked (ADR 008).
// The open session is at the top with how long it has run; the last 14 days' sessions are
// below (ADR 018). My shifts shows how they matched the roster.
export default async function ClockPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  const user = await requireUser();
  const today = localToday(ctx.tz);
  const data = await withUser(user.id, async (tx) => ({
    worker: await myWorker(tx),
    punch: await openPunch(tx),
    shifts: await myShifts(tx, today, 1),
    past: await pastSessions(tx, addDays(today, -14), ctx.tz),
  }));
  const next = data.shifts.find((s) => new Date(s.end_at) > new Date());
  return (
    <div className="space-y-4">
      <PeopleHeader ctx={ctx} active="/roster/clock" title="Clock in" />
      {!data.worker ? (
        <Empty>You are not set up as a worker.</Empty>
      ) : (
        <>
          <p className="text-sm text-slate-600" data-testid="next-shift">
            {next
              ? `${next.local_date === today ? 'Today' : 'Tomorrow'} ${formatSpan(next.start_at, next.end_at, ctx.tz)} at ${next.node_name}`
              : 'No shift rostered today.'}
          </p>
          <ClockPanel
            clockedInAt={data.punch ? new Date(data.punch.clock_in_at).toISOString() : null}
            tz={ctx.tz}
            userId={ctx.shell.user.id}
          />
          <section className="space-y-2" data-testid="past-sessions">
            <h2 className="text-sm font-semibold text-slate-500">Past 14 days</h2>
            {data.past.length === 0 ? (
              <Empty>No clock sessions yet.</Empty>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                {data.past.map((p) => (
                  <li
                    key={p.id}
                    data-testid="past-session"
                    className="flex justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <span className="font-medium">
                      {formatDay(localDate(p.clock_in_at, ctx.tz))}
                    </span>
                    <span className="text-right text-slate-600 tabular-nums">
                      In {formatTime(p.clock_in_at, ctx.tz)} · Out{' '}
                      {formatTime(p.clock_out_at, ctx.tz)}
                      <span className="block text-xs text-slate-500">
                        {formatDuration(
                          Math.floor(
                            (new Date(p.clock_out_at).getTime() -
                              new Date(p.clock_in_at).getTime()) /
                              60_000,
                          ),
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
