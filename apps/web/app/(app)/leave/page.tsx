import Link from 'next/link';
import { Icon } from '@/components/icon';
import { Empty } from '@/components/messages';
import { LEAVE_STATUS, leaveIcon } from '@/lib/leave-icons';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { formatDay, localToday } from '@/lib/dates';
import { withUser } from '@/lib/db';
import type { SearchParams } from '@/lib/inventory';
import { balances, myLeave, myWorker, peopleContext } from '@/lib/people';
import { LeaveForm } from './leave-form';
import { ModuleOff } from '@/components/module-gate';

// My leave: balances (entitled, used, pending, available), a request form and history.
export default async function LeavePage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  if (!ctx.shell.modules.has('leave')) return <ModuleOff code="leave" />;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const worker = await myWorker(tx);
    return worker ? { worker, balances: await balances(tx, null), leave: await myLeave(tx) } : null;
  });
  return (
    <div className="space-y-4">
      <PollRefresh />
      <PeopleHeader ctx={ctx} active="/leave" title="Leave" />
      {!data ? (
        <Empty>You are not set up as a worker.</Empty>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-2" data-testid="balances">
            {data.balances
              .filter((b) => b.available_days !== null)
              .map((b) => (
                <li key={b.leave_type_id} className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                  <span className="flex items-center gap-2 text-sm text-slate-600">
                    <Icon name={leaveIcon(b.code, b.name)} className="size-6 text-brand-700" />
                    {b.name}
                  </span>
                  <span className="text-2xl font-semibold tabular-nums">
                    {Number(b.available_days)}
                  </span>
                  <span className="text-xs text-slate-500">
                    {' '}
                    of {Number(b.entitled_days ?? 0)} left
                    {Number(b.pending_days) > 0 ? ` · ${Number(b.pending_days)} pending` : ''}
                  </span>
                </li>
              ))}
          </ul>
          <h2 className="text-sm font-semibold text-slate-700">My requests</h2>
          {data.leave.length === 0 ? (
            <Empty icon="umbrella">No leave yet</Empty>
          ) : (
            <ul className="space-y-2" data-testid="my-leave">
              {data.leave.map((l) => (
                <li key={l.id}>
                  <Link
                    href={`/leave/${l.id}`}
                    className="flex items-center justify-between gap-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
                  >
                    <Icon
                      name={leaveIcon(l.type_code, l.type_name)}
                      className="size-7 text-brand-700"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{l.type_name}</span>
                      <span className="text-sm text-slate-600">
                        {formatDay(l.from_date)}
                        {l.to_date !== l.from_date ? ` – ${formatDay(l.to_date)}` : ''} ·{' '}
                        {Number(l.days)} day{Number(l.days) === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="text-right text-xs text-slate-600">
                      {LEAVE_STATUS[l.status] ?? 'Waiting for approval'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {/* the balances and requests first, then asking for leave (ADR 051, 053) */}
          <LeaveForm
            today={localToday(ctx.tz)}
            types={data.balances.map((b) => ({
              id: b.leave_type_id,
              name: b.name,
              icon: leaveIcon(b.code, b.name),
              available: b.available_days === null ? null : Number(b.available_days),
            }))}
          />
        </>
      )}
    </div>
  );
}
