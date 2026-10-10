import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BackLink } from '@/components/back-link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { addDays, formatDay } from '@/lib/dates';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { givesRooms, roomAssignments, roomOutlets, roomPeople, rooms } from '@/lib/rooms';
import { sql, withUser } from '@/lib/db';
import { GiveRoomsForm } from './give-form';

// Give rooms (ADR 111): the executive housekeeper or supervisor picks a person, taps their
// rooms and saves; today's or tomorrow's. A room already someone else's moves when tapped.
// Nobody has to: an attendant with no rooms given sees every room, as before.
export default async function GiveRoomsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const places = await withUser(user.id, (tx) => roomOutlets(tx));
  const asked = param(sp, 'outlet');
  const place = places.find((p) => isUuid(asked) && p.outlet_id === asked) ?? places[0];
  if (!place) notFound();
  const data = await withUser(user.id, async (tx) => {
    const gives = await givesRooms(tx, place.outlet_id);
    if (!gives) return null;
    const today = (
      await sql<{ d: string }>`select rpt.today(${place.outlet_id}::uuid)::text as d`.execute(tx)
    ).rows[0]!.d;
    const askedDay = param(sp, 'day');
    const day = askedDay === addDays(today, 1) ? askedDay : today;
    return {
      today,
      day,
      people: await roomPeople(tx, place.outlet_id),
      list: await rooms(tx, place.outlet_id),
      given: await roomAssignments(tx, place.outlet_id, day),
    };
  });
  if (!data) notFound();
  const href = (d: string) => `/rooms/give?outlet=${place.outlet_id}&day=${d}`;
  return (
    <div className="space-y-4">
      <BackLink fallback={`/rooms?outlet=${place.outlet_id}`} />
      <div>
        <h1 className="text-xl font-semibold">Give rooms</h1>
        <p className="text-sm text-slate-600">{place.name}</p>
      </div>
      <nav aria-label="Day" className="flex gap-2">
        {[
          [data.today, 'Today'],
          [addDays(data.today, 1), 'Tomorrow'],
        ].map(([d, w]) => (
          <Link
            key={d}
            href={href(d!)}
            aria-current={d === data.day ? 'page' : undefined}
            className={`flex min-h-11 items-center rounded-full px-4 text-sm ring-1 ${
              d === data.day
                ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                : 'bg-white ring-slate-300'
            }`}
          >
            {w}, {formatDay(d!)}
          </Link>
        ))}
      </nav>
      {data.people.length === 0 ? (
        <Empty>No one works in housekeeping here.</Empty>
      ) : (
        <GiveRoomsForm
          key={data.day}
          outlet={place.outlet_id}
          day={data.day}
          people={data.people}
          rooms={data.list.map((r) => ({ room_id: r.room_id, number: r.number, floor: r.floor }))}
          given={data.given}
        />
      )}
    </div>
  );
}
