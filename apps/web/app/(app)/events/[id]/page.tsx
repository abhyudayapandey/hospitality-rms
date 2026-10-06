import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { formatDay, formatSpan, formatTime, localDate, localToday } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { isUuid, type SearchParams } from '@/lib/inventory';
import { events, peopleContext } from '@/lib/people';
import { EventForm } from '../event-form';
import { eventFormOptions } from '../options';
import { CancelEvent } from './cancel-event';
import { jobTitles } from '@/lib/job-titles';
import { formatQty } from '@/lib/qty';

export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const ctx = await peopleContext(searchParams, 'events');
  if (!isUuid(id)) return <Empty>Event not found.</Empty>;
  const user = await requireUser();
  const title = await withUser(user.id, jobTitles);
  const data = await withUser(user.id, async (tx) => {
    const [e] = await events(tx, '', '', id);
    if (!e) return null;
    const editable = ctx.can('EVENTS', 'modify') && e.status !== 'cancelled';
    return { e, options: editable ? await eventFormOptions(tx) : null };
  });
  if (!data) return <Empty>Event not found.</Empty>;
  const { e, options } = data;
  const tz = ctx.nodes.find((n) => n.id === e.org_node_id)?.timezone ?? ctx.tz;
  return (
    <div className="space-y-4">
      <Link href={`/events?node=${e.org_node_id}`} className="text-sm text-slate-600">
        ← Events
      </Link>
      <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold">{e.name}</h1>
        <p className="text-sm text-slate-600 tabular-nums">
          {formatDay(localDate(e.starts_at, tz))} · {formatSpan(e.starts_at, e.ends_at, tz)} ·{' '}
          {e.covers} covers · {e.status}
        </p>
        {e.notes && <p className="mt-1 text-sm">{e.notes}</p>}
        <ul className="mt-3 space-y-1 text-sm" data-testid="event-requirements">
          {e.requirements.map((r, i) => (
            <li key={i} className="tabular-nums">
              {r.kind === 'role'
                ? `${r.headcount} × ${title(r.role_code)} · ${formatTime(r.starts_at!, tz)}–${formatTime(r.ends_at!, tz)}`
                : `${r.item_name ?? 'Item'} · ${formatQty(r.qty ?? 0, r.base_uom ?? '')}`}
            </li>
          ))}
        </ul>
      </div>
      {options && (
        <>
          <h2 className="text-sm font-semibold text-slate-700">Edit</h2>
          <EventForm
            node={e.org_node_id}
            tz={tz}
            today={localToday(tz)}
            options={options}
            initial={{
              id: e.id,
              name: e.name,
              date: localDate(e.starts_at, tz),
              start: formatTime(e.starts_at, tz),
              end: formatTime(e.ends_at, tz),
              covers: e.covers,
              notes: e.notes ?? '',
              status: e.status === 'confirmed' ? 'confirmed' : 'planned',
              items: e.requirements
                .filter((r) => r.kind === 'item')
                .map((r) => ({ item_id: r.item_id!, qty: String(Number(r.qty)) })),
              roles: e.requirements
                .filter((r) => r.kind === 'role')
                .map((r) => ({
                  role_code: r.role_code!,
                  headcount: String(r.headcount),
                  start: formatTime(r.starts_at!, tz),
                  end: formatTime(r.ends_at!, tz),
                })),
            }}
          />
          <CancelEvent id={e.id} node={e.org_node_id} />
        </>
      )}
    </div>
  );
}
