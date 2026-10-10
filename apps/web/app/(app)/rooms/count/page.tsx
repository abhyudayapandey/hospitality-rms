import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { isUuid, param, type SearchParams } from '@/lib/params';
import { roomContents } from '@/lib/rooms';
import { RoomCountForm } from './count-form';

// Count a room's contents (ADR 094): every thing it should hold, from the room's own lines or
// its room type's. The count is kept for the room; nothing moves in the stores.
export default async function RoomCountPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const outlet = param(sp, 'outlet');
  const room = param(sp, 'room');
  const back = `/rooms?outlet=${outlet}&view=contents`;
  if (!isUuid(outlet) || !isUuid(room)) return <Empty>That room is not there.</Empty>;
  const user = await requireUser();
  const lines = (await withUser(user.id, (tx) => roomContents(tx, outlet))).filter(
    (r) => r.room_id === room,
  );
  return (
    <div className="space-y-4">
      <Link href={back} className="text-sm text-slate-600 underline">
        Back to rooms
      </Link>
      <h1 className="text-xl font-semibold">
        Count room {lines[0]?.number ?? ''}
        {lines[0]?.room_type && (
          <span className="block text-sm font-normal text-slate-600">{lines[0].room_type}</span>
        )}
      </h1>
      {lines.length === 0 ? (
        <Empty>This room has no contents listed.</Empty>
      ) : (
        <RoomCountForm room={room} back={back} lines={lines} />
      )}
    </div>
  );
}
