import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PeopleHeader } from '@/components/people-header';
import { PollRefresh } from '@/components/use-polling';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan, localDate, localToday, localToInstant } from '@/lib/dates';
import { withUser } from '@/lib/db';
import type { SearchParams } from '@/lib/inventory';
import { events, peopleContext } from '@/lib/people';

// Upcoming events at a location, by day, with covers and a summary of requirements.
export default async function EventsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  if (!ctx.can('EVENTS') || !ctx.node) {
    return <p className="text-slate-600">You don&apos;t have access to events.</p>;
  }
  const node = ctx.node;
  const user = await requireUser();
  const from = localToInstant(localToday(ctx.tz), '00:00', ctx.tz);
  const rows = await withUser(user.id, (tx) => events(tx, node.id, from));
  return (
    <div className="space-y-4">
      <PollRefresh />
      <PeopleHeader ctx={ctx} active="/events" title="Events" picker />
      {ctx.can('EVENTS', 'modify') && (
        <Link
          href={`/events/new?node=${node.id}`}
          className="flex min-h-12 items-center justify-center rounded-lg bg-slate-900 font-medium text-white"
        >
          New event
        </Link>
      )}
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
                  <p className="mt-1 text-xs text-slate-500">
                    {e.status}
                    {roles.length > 0 &&
                      ` · ${roles.map((r) => `${r.headcount} ${r.role_code!.toLowerCase()}`).join(', ')}`}
                    {items.length > 0 && ` · ${items.length} item${items.length === 1 ? '' : 's'}`}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
