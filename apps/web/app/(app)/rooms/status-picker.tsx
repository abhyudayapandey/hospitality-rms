'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Icon } from '@/components/icon';
import { ErrorBox } from '@/components/messages';
import { byFloor, floorName, ROOM_STATUSES, ROOM_TONE, roomStatus } from '@/lib/rooms-view';
import { useHydrated } from '@/lib/use-hydrated';
import { setRoomStatus } from './actions';

/**
 * A room's new status as big buttons, each its colour, picture and word (ADR 088, 104): the
 * same server action as before, never a code. The current one is marked.
 */
export function RoomStatusButtons({
  room,
  number,
  status,
  onDone,
}: {
  room: string;
  number: string;
  status: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const current = roomStatus(status).code;
  return (
    <div className="space-y-2">
      <div
        role="group"
        aria-label={`Room ${number} status`}
        className="grid grid-cols-2 gap-2"
        data-testid="room-status-buttons"
      >
        {ROOM_STATUSES.map((s) => (
          <button
            key={s.code}
            type="button"
            aria-pressed={s.code === current}
            disabled={!hydrated || pending}
            onClick={() => {
              if (s.code === current) return onDone?.();
              start(async () => {
                setError(null);
                const r = await setRoomStatus(room, s.code);
                if (!r.ok) return setError(r.message);
                onDone?.();
                router.refresh();
              });
            }}
            className={`flex min-h-14 items-center gap-2 rounded-xl px-3 text-left text-base font-semibold ring-1 ${ROOM_TONE[s.tone]} ${
              s.code === current ? 'ring-4' : ''
            }`}
          >
            <Icon name={s.icon} className="size-6 shrink-0" />
            {s.word}
          </button>
        ))}
      </div>
      <ErrorBox message={error} />
    </div>
  );
}

export interface RoomTileRow {
  room_id: string;
  number: string;
  floor: string | null;
  status: string;
  can_set: boolean;
  /** whose the room is today, when given to someone else (ADR 111) */
  who?: string | null;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

/** One room's tile: its number, its status's colour and picture, and whose it is today. */
function RoomTile({ r, onTap }: { r: RoomTileRow; onTap?: (() => void) | undefined }) {
  const s = roomStatus(r.status);
  const inner = (
    <>
      <Icon name={s.icon} className="size-5" />
      <span className="text-lg leading-tight font-bold tabular-nums">{r.number}</span>
      {r.who && (
        <span className="text-[11px] leading-none font-semibold opacity-80" data-testid="room-who">
          {initials(r.who)}
        </span>
      )}
    </>
  );
  const common = {
    'aria-label': `Room ${r.number}: ${s.word}${r.who ? `, ${r.who}'s` : ''}`,
    'data-testid': 'room',
    'data-room': r.number,
    'data-status': s.code,
    className: `flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-xl ring-1 ${ROOM_TONE[s.tone]}`,
  };
  return onTap ? (
    <button type="button" onClick={onTap} {...common}>
      {inner}
    </button>
  ) : (
    <div role="img" {...common}>
      {inner}
    </div>
  );
}

/**
 * Every room as a tile, floor by floor (ADR 104). Whoever may change a room's status taps it
 * and chooses the new one from big buttons.
 */
export function RoomGrid({ rooms }: { rooms: RoomTileRow[] }) {
  const [open, setOpen] = useState<RoomTileRow | null>(null);
  const floors = byFloor(rooms);
  return (
    <>
      {floors.map((f) => (
        <section key={f.floor} className="space-y-2" aria-label={floorName(f.floor)}>
          {floors.length > 1 && (
            <h2 className="text-sm font-semibold text-slate-500">{floorName(f.floor)}</h2>
          )}
          <div className="grid grid-cols-4 gap-2">
            {f.rooms.map((r) => (
              <RoomTile key={r.room_id} r={r} onTap={r.can_set ? () => setOpen(r) : undefined} />
            ))}
          </div>
        </section>
      ))}
      {open && (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/50"
          onClick={() => setOpen(null)}
        >
          <section
            role="dialog"
            aria-label={`Room ${open.number}`}
            data-testid="room-sheet"
            className="w-full space-y-3 rounded-t-2xl bg-white p-4 pb-8 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">Room {open.number}</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(null)}
                className="flex size-11 items-center justify-center rounded-full ring-1 ring-slate-300"
              >
                <Icon name="x" className="size-5" />
              </button>
            </div>
            <RoomStatusButtons
              room={open.room_id}
              number={open.number}
              status={open.status}
              onDone={() => setOpen(null)}
            />
          </section>
        </div>
      )}
    </>
  );
}

/** The statuses there are, each with its colour, picture and how many rooms have it. */
export function RoomLegend({ rooms }: { rooms: { status: string }[] }) {
  const counts = ROOM_STATUSES.map((s) => ({
    ...s,
    n: rooms.filter((r) => roomStatus(r.status).code === s.code).length,
  })).filter((s) => s.n > 0);
  return (
    <ul className="flex flex-wrap gap-2" data-testid="room-counts" aria-label="Room status">
      {counts.map((s) => (
        <li
          key={s.code}
          className={`inline-flex min-h-8 items-center gap-1 rounded-full px-2.5 text-sm font-medium ring-1 ${ROOM_TONE[s.tone]}`}
        >
          <Icon name={s.icon} className="size-4" />
          <span className="tabular-nums">{s.n}</span> {s.word.toLowerCase()}
        </li>
      ))}
    </ul>
  );
}
