'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Icon } from '@/components/icon';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { Stepper } from '@/components/stepper';
import { byFloor } from '@/lib/rooms-view';
import { useHydrated } from '@/lib/use-hydrated';
import { setBreakfastRoom, setBreakfastTotal } from '../rooms/actions';

type Mode = 'buffet' | 'in_room';

interface Row {
  room_id: string;
  number: string;
  guests: number;
  note: string;
}

const WORDS: Record<Mode, { label: string; add: string }> = {
  buffet: { label: 'Buffet', add: 'Add room numbers (optional)' },
  in_room: { label: 'In-room', add: 'Add a room' },
};
// Most rooms are two (ADR 110); one to four covers almost every room.
const GUESTS = [1, 2, 3, 4];

/**
 * One breakfast (ADR 110): Buffet first, then In-room, each a number of guests and, when
 * wanted, its rooms (two guests unless changed). One Save for the day. Keyed by the day on the
 * page, so moving to another day starts from that day's numbers, never this one's.
 */
export function BreakfastForm({
  outlet,
  day,
  saveLabel,
  modes,
  rooms,
}: {
  outlet: string;
  day: string;
  saveLabel: string;
  modes: { mode: Mode; total: number | null; rooms: Row[] }[];
  rooms: { room_id: string; number: string; floor: string | null }[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [totals, setTotals] = useState<Record<Mode, string>>(
    Object.fromEntries(
      modes.map((m) => [m.mode, m.total === null ? '' : String(m.total)]),
    ) as Record<Mode, string>,
  );
  const [rows, setRows] = useState<Record<Mode, Row[]>>(
    Object.fromEntries(modes.map((m) => [m.mode, m.rooms])) as Record<Mode, Row[]>,
  );
  const [adding, setAdding] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const taken = new Set(Object.values(rows).flatMap((r) => r.map((x) => x.room_id)));
  const sum = (m: Mode) => rows[m].reduce((n, r) => n + r.guests, 0);

  const addRoom = (
    m: Mode,
    room: { room_id: string; number: string },
    guests: number,
    note: string,
  ) => {
    const next = [...rows[m], { ...room, guests, note }];
    setRows({ ...rows, [m]: next });
    // the total is never less than the rooms in it
    const n = next.reduce((s, r) => s + r.guests, 0);
    if (totals[m].trim() === '' || Number(totals[m]) < n) setTotals({ ...totals, [m]: String(n) });
    setAdding(null);
    setSaved(false);
  };

  const save = () =>
    start(async () => {
      setError(null);
      for (const m of modes) {
        const v = totals[m.mode].trim();
        if (v !== '' && Number(v) !== m.total) {
          const r = await setBreakfastTotal(outlet, day, m.mode, Number(v));
          if (!r.ok) return setError(r.message);
        }
        const now = rows[m.mode];
        for (const before of m.rooms) {
          if (!now.some((x) => x.room_id === before.room_id) && !taken.has(before.room_id)) {
            const r = await setBreakfastRoom(before.room_id, day, m.mode, 0, '');
            if (!r.ok) return setError(r.message);
          }
        }
        for (const x of now) {
          const before = m.rooms.find((b) => b.room_id === x.room_id);
          if (before && before.guests === x.guests && before.note === x.note) continue;
          const r = await setBreakfastRoom(x.room_id, day, m.mode, x.guests, x.note);
          if (!r.ok) return setError(r.message);
        }
      }
      setSaved(true);
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
              {WORDS[m].label}
            </span>
            {rows[m].length > 0 && (
              <span className="text-sm font-normal text-slate-600" data-testid="breakfast-by-room">
                {sum(m)} guests in {rows[m].length} {rows[m].length === 1 ? 'room' : 'rooms'}
              </span>
            )}
          </h2>
          <Stepper
            label={`${WORDS[m].label} guests`}
            min={0}
            value={totals[m]}
            onChange={(v) => {
              setTotals({ ...totals, [m]: v });
              setSaved(false);
            }}
          />
          {rows[m].length > 0 && (
            <ul className="space-y-2">
              {rows[m].map((r, i) => (
                <li
                  key={r.room_id}
                  className="flex items-center gap-2"
                  data-testid="breakfast-room"
                >
                  <span className="w-16 shrink-0 font-bold tabular-nums">
                    <span className="sr-only">Room </span>
                    {r.number}
                  </span>
                  <span className="min-w-0 flex-1">
                    <Stepper
                      label={`Room ${r.number} guests`}
                      min={1}
                      value={String(r.guests)}
                      onChange={(v) => {
                        const n = Math.max(1, Math.round(Number(v) || 1));
                        const next = rows[m].map((x, j) => (j === i ? { ...x, guests: n } : x));
                        setRows({ ...rows, [m]: next });
                        setSaved(false);
                      }}
                    />
                  </span>
                  <button
                    type="button"
                    aria-label={`Take room ${r.number} off`}
                    onClick={() => {
                      setRows({ ...rows, [m]: rows[m].filter((_, j) => j !== i) });
                      setSaved(false);
                    }}
                    className="flex size-11 shrink-0 items-center justify-center rounded-xl text-slate-500 ring-1 ring-slate-300"
                  >
                    <Icon name="x" className="size-5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {adding === m ? (
            <AddRoom
              rooms={rooms.filter((r) => !taken.has(r.room_id))}
              onAdd={(room, guests, note) => addRoom(m, room, guests, note)}
              onCancel={() => setAdding(null)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(m)}
              className="inline-flex min-h-11 items-center gap-1 font-semibold text-brand-700"
              data-testid={`breakfast-add-${m}`}
            >
              <Icon name="plus" className="size-5" />
              {WORDS[m].add}
            </button>
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

/** Pick a room, then how many (two unless changed); a note is for the kitchen. */
function AddRoom({
  rooms,
  onAdd,
  onCancel,
}: {
  rooms: { room_id: string; number: string; floor: string | null }[];
  onAdd: (room: { room_id: string; number: string }, guests: number, note: string) => void;
  onCancel: () => void;
}) {
  const [room, setRoom] = useState<{ room_id: string; number: string } | null>(null);
  const [guests, setGuests] = useState(2);
  const [note, setNote] = useState('');
  return (
    <div
      className="space-y-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200"
      data-testid="breakfast-add"
    >
      <div role="group" aria-label="Room" className="space-y-2">
        {byFloor(rooms).map((f) => (
          <div key={f.floor} className="grid grid-cols-5 gap-2">
            {f.rooms.map((r) => (
              <button
                key={r.room_id}
                type="button"
                aria-pressed={room?.room_id === r.room_id}
                aria-label={`Room ${r.number}`}
                onClick={() => setRoom(r)}
                className={`min-h-12 rounded-lg text-base font-bold tabular-nums ring-1 ${
                  room?.room_id === r.room_id
                    ? 'bg-brand-700 text-white ring-brand-700'
                    : 'bg-white text-slate-800 ring-slate-300'
                }`}
              >
                {r.number}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div role="group" aria-label="Guests" className="flex items-center gap-2">
        <span className="text-sm font-medium">Guests</span>
        {GUESTS.map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={guests === n}
            onClick={() => setGuests(n)}
            className={`size-11 rounded-full text-base font-bold ring-1 ${
              guests === n ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white ring-slate-300'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Note for the kitchen (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!room}
          onClick={() => room && onAdd(room, guests, note.trim())}
          className={`${primaryButton} flex-1`}
        >
          {room
            ? `Add room ${room.number} · ${guests} ${guests === 1 ? 'guest' : 'guests'}`
            : 'Tap a room'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-12 rounded-xl px-4 ring-1 ring-slate-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
