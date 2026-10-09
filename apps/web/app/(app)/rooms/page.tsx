import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { roomOutlets, rooms } from '@/lib/rooms';
import { ROOM_STATUSES } from '@/lib/rooms-view';
import { RoomStatusPicker } from './status-picker';

// Rooms (ADR 088): every room of the outlet with its status, floor by floor; front office and
// housekeeping change it here or on the room check's grid. A count of each status first.
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
  const list = await withUser(user.id, (tx) => rooms(tx, place.outlet_id));
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
      {floors.map((f) => (
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
      ))}
    </div>
  );
}
