'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Icon } from '@/components/icon';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { byFloor, floorName, modeLabel, type Meal, type Mode } from '@/lib/rooms-view';
import { useHydrated } from '@/lib/use-hydrated';
import { setMealRooms } from '../rooms/actions';

export type { Meal, Mode } from '@/lib/rooms-view';

interface Row {
  room_id: string;
  number: string;
  guests: number;
  note: string;
}

/**
 * One meal (ADR 121): for each way it is served, its rooms, each a tile with − / + for its
 * guests; the meal's guests are its rooms'. "Add rooms" opens every room as a tile: tap as many
 * as come (one guest each to start), type a number to find one. One Save for the meal. Keyed by
 * the day and meal on the page, so another day starts from its own rooms.
 */
export function MealForm({
  outlet,
  day,
  meal,
  saveLabel,
  modes,
  rooms,
}: {
  outlet: string;
  day: string;
  meal: Meal;
  saveLabel: string;
  modes: { mode: Mode; rooms: Row[] }[];
  rooms: { room_id: string; number: string; floor: string | null }[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<Record<Mode, Row[]>>(
    Object.fromEntries(modes.map((m) => [m.mode, m.rooms])) as Record<Mode, Row[]>,
  );
  const [adding, setAdding] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const sum = (m: Mode) => rows[m].reduce((n, r) => n + r.guests, 0);
  const elsewhere = (m: Mode) =>
    new Set(
      Object.entries(rows)
        .filter(([k]) => k !== m)
        .flatMap(([, r]) => r.map((x) => x.room_id)),
    );
  const setGuests = (m: Mode, room: { room_id: string; number: string }, guests: number) => {
    const has = rows[m].some((r) => r.room_id === room.room_id);
    const next =
      guests <= 0
        ? rows[m].filter((r) => r.room_id !== room.room_id)
        : has
          ? rows[m].map((r) => (r.room_id === room.room_id ? { ...r, guests } : r))
          : [...rows[m], { ...room, guests, note: '' }];
    setRows({ ...rows, [m]: next });
    setSaved(false);
  };

  const save = () =>
    start(async () => {
      setError(null);
      for (const m of modes) {
        const now = rows[m.mode];
        // what changed: new or other numbers, and those taken off (0)
        const lines = [
          ...now
            .filter((x) => {
              const b = m.rooms.find((r) => r.room_id === x.room_id);
              return !b || b.guests !== x.guests || b.note !== x.note;
            })
            .map((x) => ({ room_id: x.room_id, guests: x.guests, note: x.note })),
          ...m.rooms
            .filter((b) => !now.some((x) => x.room_id === b.room_id))
            .filter((b) => !elsewhere(m.mode).has(b.room_id))
            .map((b) => ({ room_id: b.room_id, guests: 0, note: '' })),
        ];
        if (lines.length === 0) continue;
        const r = await setMealRooms(outlet, day, meal, m.mode, lines);
        if (!r.ok) return setError(r.message);
      }
      setSaved(true);
      setAdding(null);
      router.refresh();
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {modes.map(({ mode: m }) => (
        <section
          key={m}
          className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
          data-testid={`breakfast-${m}`}
        >
          <h2 className="flex items-baseline justify-between font-semibold">
            <span className="inline-flex items-center gap-2">
              <Icon name={m === 'in_room' ? 'bed' : 'plate'} className="size-5 text-brand-700" />
              {modeLabel(meal, m)}
            </span>
            <span className="text-sm font-normal text-slate-600" data-testid="breakfast-by-room">
              {rows[m].length === 0
                ? 'no rooms yet'
                : `${sum(m)} ${sum(m) === 1 ? 'guest' : 'guests'} in ${rows[m].length} ${
                    rows[m].length === 1 ? 'room' : 'rooms'
                  }`}
            </span>
          </h2>
          {adding === m ? (
            <RoomPicker
              rooms={rooms.filter((r) => !elsewhere(m).has(r.room_id))}
              chosen={rows[m]}
              onGuests={(room, n) => setGuests(m, room, n)}
              onDone={() => setAdding(null)}
            />
          ) : (
            <>
              {rows[m].length > 0 && (
                <ul className="grid grid-cols-3 gap-2">
                  {[...rows[m]]
                    .sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }))
                    .map((r) => (
                      <RoomTile
                        key={r.room_id}
                        room={r}
                        guests={r.guests}
                        onGuests={(n) => setGuests(m, r, n)}
                      />
                    ))}
                </ul>
              )}
              <button
                type="button"
                onClick={() => setAdding(m)}
                className="inline-flex min-h-11 items-center gap-1 font-semibold text-brand-700"
                data-testid={`breakfast-add-${m}`}
              >
                <Icon name="plus" className="size-5" />
                Add rooms
              </button>
            </>
          )}
        </section>
      ))}
      <ErrorBox message={error} />
      {saved && !pending && (
        <p className="text-sm font-semibold text-emerald-700" role="status">
          Saved.
        </p>
      )}
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        {saveLabel}
      </button>
    </form>
  );
}

/** A room taken: its number, and − / + for its guests in the tile; − at one takes it off. */
function RoomTile({
  room,
  guests,
  onGuests,
}: {
  room: { number: string };
  guests: number;
  onGuests: (n: number) => void;
}) {
  return (
    <li
      className="flex flex-col items-center gap-1 rounded-xl bg-brand-50 p-2 text-brand-900 ring-2 ring-brand-700"
      data-testid="breakfast-room"
      data-room={room.number}
    >
      <span className="text-lg leading-tight font-bold tabular-nums">
        <span className="sr-only">Room </span>
        {room.number}
      </span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`One fewer in room ${room.number}`}
          onClick={() => onGuests(guests - 1)}
          className="flex size-9 items-center justify-center rounded-full bg-white text-lg font-bold ring-1 ring-slate-300"
        >
          −
        </button>
        <span
          className="w-6 text-center text-base font-bold tabular-nums"
          aria-label={`${guests} guests`}
          data-testid="room-guests"
        >
          {guests}
        </span>
        <button
          type="button"
          aria-label={`One more in room ${room.number}`}
          onClick={() => onGuests(Math.min(20, guests + 1))}
          className="flex size-9 items-center justify-center rounded-full bg-white text-lg font-bold ring-1 ring-slate-300"
        >
          +
        </button>
      </span>
    </li>
  );
}

/**
 * Every room as a tile, floor by floor (ADR 121): tap one to take it (one guest), the taken
 * ones with − / + in the tile. A number typed finds a room. Done goes back to the meal.
 */
function RoomPicker({
  rooms,
  chosen,
  onGuests,
  onDone,
}: {
  rooms: { room_id: string; number: string; floor: string | null }[];
  chosen: Row[];
  onGuests: (room: { room_id: string; number: string }, n: number) => void;
  onDone: () => void;
}) {
  const [find, setFind] = useState('');
  const shown = rooms.filter((r) => r.number.toLowerCase().includes(find.trim().toLowerCase()));
  const floors = byFloor(shown);
  return (
    <div className="space-y-3" data-testid="breakfast-add">
      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        inputMode="numeric"
        placeholder="Room number"
        aria-label="Find a room"
        className={inputClass}
      />
      {floors.map((f) => (
        <div key={f.floor} className="space-y-1">
          {floors.length > 1 && (
            <h3 className="text-sm font-semibold text-slate-500">{floorName(f.floor)}</h3>
          )}
          <ul className="grid grid-cols-3 gap-2" role="group" aria-label={floorName(f.floor)}>
            {f.rooms.map((r) => {
              const taken = chosen.find((c) => c.room_id === r.room_id);
              return taken ? (
                <RoomTile
                  key={r.room_id}
                  room={r}
                  guests={taken.guests}
                  onGuests={(n) => onGuests(r, n)}
                />
              ) : (
                <li key={r.room_id}>
                  <button
                    type="button"
                    aria-pressed={false}
                    aria-label={`Room ${r.number}`}
                    onClick={() => onGuests(r, 1)}
                    className="flex min-h-[4.5rem] w-full items-center justify-center rounded-xl bg-white text-lg font-bold text-slate-800 tabular-nums ring-1 ring-slate-300"
                    data-testid="breakfast-pick"
                    data-room={r.number}
                  >
                    {r.number}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {shown.length === 0 && <p className="text-sm text-slate-600">No room {find}.</p>}
      <button
        type="button"
        onClick={onDone}
        className="min-h-12 w-full rounded-xl font-semibold ring-1 ring-slate-300"
        data-testid="breakfast-picked"
      >
        Done · {chosen.length} {chosen.length === 1 ? 'room' : 'rooms'}
      </button>
    </div>
  );
}
