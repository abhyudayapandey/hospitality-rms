import { BackLink } from '@/components/back-link';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { photosEnabled } from '@/lib/photos';
import { placesFor } from '@/lib/places';
import type { SearchParams } from '@/lib/params';
import { roomOutlets, rooms } from '@/lib/rooms';
import { ReportForm } from '../maintenance-forms';

// Report a problem (ADR 052, 113): one form, no tabs. Where they work is chosen; any other place
// they may report at, and a hotel's rooms, are a tap away.
export default async function ReportProblemPage({ searchParams }: { searchParams: SearchParams }) {
  const { places, place, shell } = await placesFor('report', searchParams);
  const user = await requireUser();
  const roomList =
    place && shell.domains.has('ROOMS')
      ? await withUser(user.id, async (tx) => {
          const o = (await roomOutlets(tx))[0];
          return o ? rooms(tx, o.outlet_id) : [];
        })
      : [];
  return (
    <div className="space-y-4">
      <BackLink />
      <h1 className="text-xl font-semibold">Report a problem</h1>
      {place ? (
        <ReportForm
          place={place.id}
          places={places.map((p) => ({ id: p.id, name: placeShort(p.name) }))}
          rooms={roomList.map((r) => ({ room_id: r.room_id, number: r.number, floor: r.floor }))}
          photos={photosEnabled()}
        />
      ) : (
        <p className="rounded-xl bg-white p-6 text-center text-slate-600 ring-1 ring-slate-200">
          You don&apos;t work at a place where problems can be reported.
        </p>
      )}
    </div>
  );
}

/** "Test Bar 3.0 – Kitchen" -> "Kitchen": the outlet is already known. */
function placeShort(name: string): string {
  const i = name.lastIndexOf(' – ');
  return i >= 0 ? name.slice(i + 3) : name;
}
