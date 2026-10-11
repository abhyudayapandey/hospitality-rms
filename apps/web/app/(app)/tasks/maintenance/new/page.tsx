import { maintenanceWhereWord } from '@outlet-ops/domain';
import { BackLink } from '@/components/back-link';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { photosEnabled } from '@/lib/photos';
import { placesFor } from '@/lib/places';
import type { SearchParams } from '@/lib/params';
import { roomOutlets, rooms } from '@/lib/rooms';
import { ReportForm } from '../maintenance-forms';

// Report a problem (ADR 052, 113, 125): one form, no tabs. Raised where they work; where the
// problem is, is a location at their outlet (a room by its number, the parking, the kitchen).
export default async function ReportProblemPage({ searchParams }: { searchParams: SearchParams }) {
  const { place, shell } = await placesFor('report', searchParams);
  const user = await requireUser();
  const { roomList, wheres } = place
    ? await withUser(user.id, async (tx) => {
        const o = shell.domains.has('ROOMS') ? (await roomOutlets(tx))[0] : undefined;
        const w = await sql<{ code: string }>`
          select w as code from ops.maintenance_wheres(${place.id}::uuid) w`.execute(tx);
        return {
          roomList: o ? await rooms(tx, o.outlet_id) : [],
          wheres: w.rows.map((r) => ({
            code: r.code,
            word: maintenanceWhereWord(r.code) ?? r.code,
          })),
        };
      })
    : { roomList: [], wheres: [] };
  return (
    <div className="space-y-4">
      <BackLink />
      <h1 className="text-xl font-semibold">Report a problem</h1>
      {place ? (
        <ReportForm
          place={place.id}
          wheres={roomList.length > 0 ? wheres : wheres.filter((w) => w.code !== 'room')}
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
