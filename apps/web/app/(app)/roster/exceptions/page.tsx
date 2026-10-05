import Link from 'next/link';
import { FilterList } from '@/components/filter-list';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/inventory';
import {
  EXCEPTION_LABEL,
  exceptionSelfies,
  exceptions,
  exceptionsAll,
  peopleContext,
  type ExceptionRow,
} from '@/lib/people';
import { photosEnabled, presignPhotoView } from '@/lib/photos';
import { ResolveForm } from './resolve-form';

function detail(e: ExceptionRow): string {
  if (e.kind === 'late' && e.detail.minutes !== undefined) return `${e.detail.minutes} min late`;
  if (e.kind === 'left_early' && e.detail.minutes !== undefined) {
    return `Left ${e.detail.minutes} min early`;
  }
  if (e.kind === 'outside_geofence' && e.detail.distance_m !== undefined) {
    return `${Math.round(e.detail.distance_m)} m away at clock-${e.phase ?? 'in'}`;
  }
  if (e.kind === 'no_location') return `No location at clock-${e.phase ?? 'in'}`;
  if (e.kind === 'no_selfie')
    return 'Clocked in without a selfie (no camera, or it did not upload)';
  if (e.kind === 'new_device') {
    return `Clocked in on a phone not used before${e.detail.device_model ? ` (${e.detail.device_model})` : ''}`;
  }
  if (e.kind === 'shared_device') {
    return `The same phone was used to clock in for more than one person today${e.detail.device_model ? ` (${e.detail.device_model})` : ''}`;
  }
  return '';
}

// Attendance exceptions for a location and its departments, grouped by department:
// computed nightly (late, no show, no clock-out, not rostered) or at the punch (outside the
// fence, no location). Each waits for whoever runs that department's roster (ADR 009).
export default async function ExceptionsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams, 'exceptions');
  if (!ctx.node) {
    // staff see their own exceptions on My shifts (audit #10)
    return <p className="text-slate-600">You don&apos;t review attendance anywhere.</p>;
  }
  const node = ctx.node;
  const sp = await searchParams;
  const status = param(sp, 'status') === 'closed' ? 'closed' : 'open';
  // "All departments" (ADR 048): what Home's attendance issues count opens
  const all = param(sp, 'all') === '1' && ctx.nodes.length > 1;
  const user = await requireUser();
  const { rows, selfies } = await withUser(user.id, async (tx) => {
    const rows = all
      ? await exceptionsAll(
          tx,
          ctx.nodes.map((n) => n.id),
          status,
        )
      : await exceptions(tx, node.id, status);
    return {
      rows,
      selfies: await exceptionSelfies(
        tx,
        rows.map((r) => r.id),
      ),
    };
  });
  // selfies are shown only to those the database lets see them (HR, the department head)
  const selfieUrls = new Map<string, string>();
  if (photosEnabled()) {
    await Promise.all(
      [...selfies].map(async ([id, key]) => selfieUrls.set(id, await presignPhotoView(key))),
    );
  }
  const canResolve = ctx.can('ATTENDANCE', 'modify');
  // one group per department (or the place itself), in tree order
  const groups: { id: string; name: string; rows: ExceptionRow[] }[] = [];
  for (const e of rows) {
    const same = groups.find((g) => g.id === e.place_id);
    if (same) same.rows.push(e);
    else groups.push({ id: e.place_id, name: e.place_name, rows: [e] });
  }
  return (
    <div className="space-y-4">
      <PollRefresh />
      <PeopleHeader
        ctx={ctx}
        active="/roster/exceptions"
        title="Exceptions"
        all={ctx.nodes.length > 1 ? { label: 'All departments', on: all } : undefined}
      />
      <div className="grid grid-cols-2 gap-2 text-sm">
        {(['open', 'closed'] as const).map((s) => (
          <Link
            key={s}
            href={`/roster/exceptions?node=${node.id}${all ? '&all=1' : ''}&status=${s}`}
            aria-current={s === status ? 'page' : undefined}
            className={`flex min-h-11 items-center justify-center rounded-lg ${
              s === status
                ? 'bg-brand-700 font-semibold text-white'
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
        <div className="space-y-4" data-testid="exceptions">
          {groups.map((g) => (
            <section key={g.id} aria-label={g.name}>
              <details open className="space-y-2">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-700">
                  {g.name}{' '}
                  <span className="ml-1 font-normal text-slate-500">({g.rows.length})</span>
                </summary>
                <FilterList
                  limit={10}
                  searchFrom={10}
                  noun="exceptions"
                  listClass="space-y-2"
                  rows={g.rows.map((e) => ({
                    key: e.id,
                    text: `${e.worker_name} ${EXCEPTION_LABEL[e.kind] ?? e.kind}`,
                    attrs: { className: 'rounded-xl bg-white p-4 ring-1 ring-slate-200' },
                    node: (
                      <>
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
                        {selfieUrls.get(e.id) && (
                          // eslint-disable-next-line @next/next/no-img-element -- a 5-minute signed URL
                          <img
                            src={selfieUrls.get(e.id)}
                            alt={`Selfie of ${e.worker_name} at clock-in`}
                            width={96}
                            height={96}
                            data-testid="selfie"
                            className="mt-2 h-24 w-24 rounded-lg object-cover"
                          />
                        )}
                        {e.status !== 'open' ? (
                          <p className="mt-1 text-sm text-slate-600">
                            {e.status === 'resolved' ? 'Resolved' : 'Dismissed'}
                            {e.resolution_note ? `: ${e.resolution_note}` : ''}
                          </p>
                        ) : (
                          <>
                            <p className="mt-1 text-xs text-slate-500" data-testid="assignee">
                              {e.assigned_to_me
                                ? 'Waiting for you'
                                : `Waiting for ${e.assignee_names?.join(', ') || 'nobody (no one to review)'}`}
                            </p>
                            {e.owner_user_id === ctx.shell.user.id ? (
                              <p className="mt-2 text-xs text-slate-500">
                                Your own exception: someone else reviews it.
                              </p>
                            ) : (
                              (canResolve || e.assigned_to_me) && <ResolveForm id={e.id} />
                            )}
                          </>
                        )}
                      </>
                    ),
                  }))}
                />
              </details>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
