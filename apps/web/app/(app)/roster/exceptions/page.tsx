import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/inventory';
import { EXCEPTION_LABEL, exceptions, peopleContext, type ExceptionRow } from '@/lib/people';
import { ResolveForm } from './resolve-form';

function detail(e: ExceptionRow): string {
  if (e.kind === 'late' && e.detail.minutes !== undefined) return `${e.detail.minutes} min late`;
  if (e.kind === 'outside_geofence' && e.detail.distance_m !== undefined) {
    return `${Math.round(e.detail.distance_m)} m away at clock-${e.phase ?? 'in'}`;
  }
  if (e.kind === 'no_location') return `No location at clock-${e.phase ?? 'in'}`;
  return '';
}

// Attendance exceptions for one location: computed nightly (late, no show, no clock-out,
// not rostered) or at the punch (outside the fence, no location). Managers resolve them.
export default async function ExceptionsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  if (!ctx.can('ATTENDANCE') || !ctx.node) {
    return <p className="text-slate-600">You don&apos;t have access to attendance.</p>;
  }
  const node = ctx.node;
  const status = param(await searchParams, 'status') === 'closed' ? 'closed' : 'open';
  const user = await requireUser();
  const rows = await withUser(user.id, async (tx) =>
    status === 'open'
      ? exceptions(tx, node.id, 'open')
      : [
          ...(await exceptions(tx, node.id, 'resolved')),
          ...(await exceptions(tx, node.id, 'dismissed')),
        ],
  );
  const canResolve = ctx.can('ATTENDANCE', 'modify');
  return (
    <div className="space-y-4">
      <PollRefresh />
      <PeopleHeader ctx={ctx} active="/roster/exceptions" title="Exceptions" picker />
      <div className="grid grid-cols-2 gap-2 text-sm">
        {(['open', 'closed'] as const).map((s) => (
          <Link
            key={s}
            href={`/roster/exceptions?node=${node.id}&status=${s}`}
            aria-current={s === status ? 'page' : undefined}
            className={`flex min-h-11 items-center justify-center rounded-lg ${
              s === status
                ? 'bg-slate-900 font-semibold text-white'
                : 'bg-white ring-1 ring-slate-300'
            }`}
          >
            {s === 'open' ? 'To review' : 'Done'}
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty>{status === 'open' ? 'Nothing to review.' : 'Nothing resolved yet.'}</Empty>
      ) : (
        <ul className="space-y-2" data-testid="exceptions">
          {rows.map((e) => (
            <li key={e.id} className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
              <div className="flex items-start justify-between gap-2">
                <span>
                  <span className="block font-medium">{e.worker_name}</span>
                  <span className="text-sm text-slate-600">
                    {formatDay(e.local_date)}
                    {e.shift_start && e.shift_end
                      ? ` · ${formatSpan(e.shift_start, e.shift_end, ctx.tz)}`
                      : ''}
                  </span>
                </span>
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                  {EXCEPTION_LABEL[e.kind] ?? e.kind}
                </span>
              </div>
              {detail(e) && <p className="mt-1 text-sm text-slate-600">{detail(e)}</p>}
              {e.status !== 'open' ? (
                <p className="mt-1 text-sm text-slate-600">
                  {e.status === 'resolved' ? 'Resolved' : 'Dismissed'}
                  {e.resolution_note ? `: ${e.resolution_note}` : ''}
                </p>
              ) : e.owner_user_id === ctx.shell.user.id ? (
                <p className="mt-2 text-xs text-slate-500">
                  Your own exception: someone else reviews it.
                </p>
              ) : (
                canResolve && <ResolveForm id={e.id} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
