import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { isUuid, param, type SearchParams } from '@/lib/params';
import {
  givesRooms,
  roomContents,
  roomOutlets,
  rooms,
  type RoomContentRow,
  type RoomRow,
} from '@/lib/rooms';
import { Icon } from '@/components/icon';
import { ViewTabs } from '@/components/view-tabs';
import { formatQty } from '@/lib/qty';
import { ItemThumb } from '@/components/item-thumb';
import { RoomGrid, RoomLegend } from './status-picker';

// Rooms (ADR 088, 094, 104): every room of the outlet as a tile coloured by its status, floor
// by floor; front office and housekeeping tap one to change it (or on the room check's grid).
// How many rooms have each status first, as the legend.
// The Contents tab: what each room should hold and what was last counted there.
// Rooms given to me today come first (ADR 111), every other room folded under them, so an
// attendant still sees and helps with the rest. Whoever gives out rooms has "Give rooms".
export default async function RoomsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const places = await withUser(user.id, (tx) => roomOutlets(tx));
  const asked = param(sp, 'outlet');
  const place = places.find((p) => isUuid(asked) && p.outlet_id === asked) ?? places[0];
  if (!place) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Rooms</h1>
        <Empty>You don&apos;t look after any rooms.</Empty>
      </div>
    );
  }
  const view = param(sp, 'view') === 'contents' ? 'contents' : 'status';
  const { list, contents, gives } = await withUser(user.id, async (tx) => ({
    list: await rooms(tx, place.outlet_id),
    contents: view === 'contents' ? await roomContents(tx, place.outlet_id) : [],
    gives: await givesRooms(tx, place.outlet_id),
  }));
  const tile = (r: RoomRow) => ({
    room_id: r.room_id,
    number: r.number,
    floor: r.floor,
    status: r.status,
    can_set: r.can_set,
    who: r.mine ? null : r.given_to_name,
  });
  const mine = list.filter((r) => r.mine);
  const others = list.filter((r) => !r.mine);
  const tabs = (
    <ViewTabs
      label="Rooms"
      current={view}
      tabs={[
        { key: 'status', label: 'Status', href: `/rooms?outlet=${place.outlet_id}` },
        {
          key: 'contents',
          label: 'Contents',
          href: `/rooms?outlet=${place.outlet_id}&view=contents`,
        },
      ]}
    />
  );
  return (
    <div className="space-y-4">
      {places.length > 1 && (
        <nav aria-label="Outlet" className="flex flex-wrap gap-2">
          {places.map((p) => (
            <Link
              key={p.outlet_id}
              href={`/rooms?outlet=${p.outlet_id}`}
              aria-current={p.outlet_id === place.outlet_id ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium ring-1 ${
                p.outlet_id === place.outlet_id
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-700 ring-slate-300'
              }`}
            >
              {p.name}
            </Link>
          ))}
        </nav>
      )}
      <h1 className="text-xl font-semibold">Rooms</h1>
      {tabs}
      {view === 'contents' ? (
        <Contents rows={contents} outlet={place.outlet_id} />
      ) : (
        <>
          {mine.length > 0 ? (
            <>
              <section className="space-y-3" data-testid="my-rooms">
                <h2 className="font-semibold">Your rooms ({mine.length})</h2>
                <RoomLegend rooms={mine} />
                <RoomGrid rooms={mine.map(tile)} />
              </section>
              <details className="space-y-3" data-testid="other-rooms">
                <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
                  Other rooms ({others.length})
                </summary>
                <RoomLegend rooms={others} />
                <RoomGrid rooms={others.map(tile)} />
              </details>
            </>
          ) : (
            <>
              <RoomLegend rooms={list} />
              <RoomGrid rooms={list.map(tile)} />
            </>
          )}
          {gives && (
            <Link
              href={`/rooms/give?outlet=${place.outlet_id}`}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl font-semibold ring-1 ring-slate-300"
              data-testid="give-rooms"
            >
              <Icon name="people" className="size-5" />
              Give rooms
            </Link>
          )}
        </>
      )}
    </div>
  );
}

/** What each room should hold and its last count; short lines in red (ADR 094). */
function Contents({ rows, outlet }: { rows: RoomContentRow[]; outlet: string }) {
  if (rows.length === 0) return <Empty>No room has its contents listed.</Empty>;
  const byRoom = [...new Map(rows.map((r) => [r.room_id, r])).values()];
  return (
    <ul className="space-y-3">
      {byRoom.map((room) => {
        const lines = rows.filter((r) => r.room_id === room.room_id);
        return (
          <li
            key={room.room_id}
            className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200"
            data-testid="room-contents"
          >
            <div className="flex items-center justify-between gap-2">
              <span>
                <span className="block text-base font-medium">{room.number}</span>
                <span className="block text-xs text-slate-500">{room.room_type}</span>
              </span>
              <Link
                href={`/rooms/count?outlet=${outlet}&room=${room.room_id}`}
                className="inline-flex min-h-11 items-center text-sm font-medium underline"
              >
                Count this room
              </Link>
            </div>
            <ul className="divide-y divide-slate-100 text-sm">
              {lines.map((l) => {
                const short = l.counted !== null && Number(l.counted) < Number(l.expected);
                return (
                  <li
                    key={l.item_id}
                    className="flex items-center gap-3 py-2"
                    data-testid="room-line"
                  >
                    <ItemThumb name={l.item} size="size-8" />
                    <span className="min-w-0 flex-1">{l.item}</span>
                    <span className="shrink-0 text-right tabular-nums">
                      <span className="block">should have {formatQty(l.expected, l.unit)}</span>
                      {l.counted !== null && (
                        <span
                          className={`block text-xs ${short ? 'text-rose-800' : 'text-slate-500'}`}
                          data-testid="room-counted"
                        >
                          counted {formatQty(l.counted, l.unit)}
                          {l.counted_at && `, ${formatWhen(l.counted_at)}`}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
