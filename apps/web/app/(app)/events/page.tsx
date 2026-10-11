import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan, localDate, localToday, localToInstant } from '@/lib/dates';
import { sql, withUser } from '@/lib/db';
import type { SearchParams } from '@/lib/inventory';
import { events, peopleContext } from '@/lib/people';
import { jobTitles } from '@/lib/job-titles';

// Upcoming events at a location, by day, with covers and a summary of requirements.
export default async function EventsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams, 'events');
  if (!ctx.can('EVENTS') || !ctx.node) {
    return <p className="text-slate-600">You don&apos;t have access to events.</p>;
  }
  const node = ctx.node;
  const user = await requireUser();
  const title = await withUser(user.id, jobTitles);
  const from = localToInstant(localToday(ctx.tz), '00:00', ctx.tz);
  const { rows, staff } = await withUser(user.id, async (tx) => {
    const rows = await events(tx, node.id, from);
    // whether each event has its people (ADR 114): rostered against needed, by job role
    const staff =
      rows.length > 0
        ? (
            await sql<{ id: string; needed: number; rostered: number }>`
              select e.id::text, coalesce(sum(s.needed), 0)::int as needed,
                     coalesce(sum(least(s.rostered, s.needed)), 0)::int as rostered
                from unnest(${rows.map((r) => r.id)}::uuid[]) e(id)
                left join lateral ops.event_staffing(e.id) s on true
               group by e.id`.execute(tx)
          ).rows
        : [];
    return { rows, staff: new Map(staff.map((x) => [x.id, x])) };
  });
  return (
    <div className="space-y-4">
      <PollRefresh />
      <PeopleHeader ctx={ctx} active="/events" title="Events" />
      {rows.length === 0 ? (
        <Empty>No upcoming events.</Empty>
      ) : (
        <ul className="space-y-2" data-testid="events">
          {rows.map((e) => {
            const roles = e.requirements.filter((r) => r.kind === 'role');
            const items = e.requirements.filter((r) => r.kind === 'item');
            return (
              <li key={e.id}>
                <Link
                  href={`/events/${e.id}?node=${node.id}`}
                  className="block rounded-xl bg-white p-4 ring-1 ring-slate-200"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span>
                      <span className="block font-medium">{e.name}</span>
                      <span className="text-sm text-slate-600 tabular-nums">
                        {formatDay(localDate(e.starts_at, ctx.tz))} ·{' '}
                        {formatSpan(e.starts_at, e.ends_at, ctx.tz)}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block text-lg font-semibold tabular-nums">{e.covers}</span>
                      <span className="text-xs text-slate-500">covers</span>
                    </span>
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {(() => {
                      const st = staff.get(e.id);
                      if (!st || st.needed === 0) return null;
                      const short = st.rostered < st.needed;
                      return (
                        <span
                          className={`rounded-full px-2 py-0.5 font-semibold tabular-nums ${
                            short ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'
                          }`}
                          data-testid="event-staffed"
                          title={roles
                            .map((r) => `${r.headcount} ${title(r.role_code)}`)
                            .join(', ')}
                        >
                          {st.rostered} of {st.needed} rostered
                        </span>
                      );
                    })()}
                    {items.length > 0 && (
                      <span>
                        {items.length} {items.length === 1 ? 'item' : 'items'}
                      </span>
                    )}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {ctx.can('EVENTS', 'modify') && (
        <Link
          href={`/events/new?node=${node.id}`}
          className="flex min-h-12 items-center justify-center rounded-lg bg-brand-700 font-medium text-white"
        >
          New event
        </Link>
      )}
    </div>
  );
}
