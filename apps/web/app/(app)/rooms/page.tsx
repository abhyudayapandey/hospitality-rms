import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { roomContents, roomOutlets, rooms, type RoomContentRow } from '@/lib/rooms';
import { ViewTabs } from '@/components/view-tabs';
import { formatQty } from '@/lib/qty';
import { ItemThumb } from '@/components/item-thumb';
import { ROOM_STATUSES } from '@/lib/rooms-view';
import { RoomStatusPicker } from './status-picker';

// Rooms (ADR 088, 094): every room of the outlet with its status, floor by floor; front office
// and housekeeping change it here or on the room check's grid. A count of each status first.
// The Contents tab: what each room should hold and what was last counted there.
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
  const { list, contents } = await withUser(user.id, async (tx) => ({
    list: await rooms(tx, place.outlet_id),
    contents: view === 'contents' ? await roomContents(tx, place.outlet_id) : [],
  }));
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
  const floors = [...new Set(list.map((r) => r.floor ?? ''))];
  const counts = ROOM_STATUSES.map((s) => ({
    ...s,
    n: list.filter((r) => r.status === s.code).length,
  })).filter((s) => s.n > 0);
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
      <div>
        <h1 className="text-xl font-semibold">Rooms</h1>
        <p className="text-sm text-slate-600" data-testid="room-counts">
          {place.name}: {counts.map((s) => `${s.n} ${s.name.toLowerCase()}`).join(' · ')}
        </p>
      </div>
      {tabs}
      {view === 'contents' ? (
        <Contents rows={contents} outlet={place.outlet_id} />
      ) : (
        floors.map((f) => (
          <section key={f} className="space-y-2">
            {floors.length > 1 && (
              <h2 className="text-sm font-semibold text-slate-500">{f ? `Floor ${f}` : 'Rooms'}</h2>
            )}
            <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
              {list
                .filter((r) => (r.floor ?? '') === f)
                .map((r) => (
                  <li
                    key={r.room_id}
                    className="flex items-center justify-between gap-3 px-4 py-2"
                    data-testid="room"
                    data-status={r.status}
                  >
                    <span className="min-w-0">
                      <span className="block text-base font-medium">{r.number}</span>
                      <span className="block text-xs text-slate-500">
                        {r.room_type}
                        {r.set_at && ` · ${r.set_by_name ?? 'someone'}, ${formatWhen(r.set_at)}`}
                      </span>
                    </span>
                    {r.can_set ? (
                      <RoomStatusPicker room={r.room_id} number={r.number} status={r.status} />
                    ) : (
                      <span className="text-sm">{r.status_name}</span>
                    )}
                  </li>
                ))}
            </ul>
          </section>
        ))
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
