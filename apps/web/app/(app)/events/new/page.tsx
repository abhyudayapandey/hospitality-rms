import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { localToday } from '@/lib/dates';
import { withUser } from '@/lib/db';
import type { SearchParams } from '@/lib/inventory';
import { peopleContext } from '@/lib/people';
import { EventForm } from '../event-form';
import { eventFormOptions } from '../options';

export default async function NewEventPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await peopleContext(searchParams);
  if (!ctx.can('EVENTS', 'modify') || !ctx.node)
    return <Empty>You can&apos;t create events.</Empty>;
  const node = ctx.node;
  const user = await requireUser();
  const options = await withUser(user.id, (tx) => eventFormOptions(tx));
  return (
    <div className="space-y-4">
      <Link href={`/events?node=${node.id}`} className="text-sm text-slate-600">
        ← Events
      </Link>
      <h1 className="text-xl font-semibold">New event · {node.name}</h1>
      <EventForm node={node.id} tz={ctx.tz} today={localToday(ctx.tz)} options={options} />
    </div>
  );
}
