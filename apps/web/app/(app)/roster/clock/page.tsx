import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { requireUser } from '@/lib/auth/server';
import { formatSpan, localToday } from '@/lib/dates';
import { withUser } from '@/lib/db';
import type { SearchParams } from '@/lib/inventory';
import { myShifts, myWorker, openPunch, peopleContext } from '@/lib/people';
import { ClockPanel } from './clock-panel';

// Clock in/out. Location is checked against the outlet's geofence in SQL; outside the
// fence or without location the punch is recorded and flagged, never blocked (ADR 008).
export default async function ClockPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  const user = await requireUser();
  const today = localToday(ctx.tz);
  const data = await withUser(user.id, async (tx) => ({
    worker: await myWorker(tx),
    punch: await openPunch(tx),
    shifts: await myShifts(tx, today, 1),
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
          />
        </>
      )}
    </div>
  );
}
