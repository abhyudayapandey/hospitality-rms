'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox } from '@/components/messages';
import { ROOM_STATUSES } from '@/lib/rooms-view';
import { useHydrated } from '@/lib/use-hydrated';
import { setRoomStatus } from './actions';

/** A room's status, changed by whoever keeps the rooms (ADR 088). */
export function RoomStatusPicker({
  room,
  number,
  status,
}: {
  room: string;
  number: string;
  status: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-block">
      <select
        aria-label={`Room ${number} status`}
        value={status}
        disabled={!hydrated || pending}
        onChange={(e) =>
          start(async () => {
            setError(null);
            const r = await setRoomStatus(room, e.target.value);
            if (!r.ok) setError(r.message);
            else router.refresh();
          })
        }
        className="min-h-11 rounded-lg bg-white px-2 text-sm ring-1 ring-slate-300"
      >
        {ROOM_STATUSES.map((s) => (
          <option key={s.code} value={s.code}>
            {s.code} · {s.name}
          </option>
        ))}
      </select>
      <ErrorBox message={error} />
    </span>
  );
}
