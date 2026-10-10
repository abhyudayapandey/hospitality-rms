'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Icon } from '@/components/icon';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { Stepper } from '@/components/stepper';
import { byFloor } from '@/lib/rooms-view';
import { useHydrated } from '@/lib/use-hydrated';
import { setBreakfastRoom, setBreakfastTotal } from '../rooms/actions';

const MODES = [
  ['in_room', 'In-room'],
  ['buffet', 'Buffet'],
] as const;

/** The day's totals by mode (front office, ADR 094); empty boxes are left as they are. */
export function BreakfastTotals({
  outlet,
  day,
  totals,
}: {
  outlet: string;
  day: string;
  totals: Record<string, number | null>;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(MODES.map(([m]) => [m, totals[m] === null ? '' : String(totals[m])])),
  );
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      setError(null);
      for (const [m] of MODES) {
        const v = (values[m] ?? '').trim();
        if (v === '') continue;
        const r = await setBreakfastTotal(outlet, day, m, Number(v));
        if (!r.ok) return setError(r.message);
      }
      router.refresh();
    });
  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h2 className="font-semibold">Guests for breakfast</h2>
      <div className="space-y-3">
        {MODES.map(([m, label]) => (
          <div key={m} className="space-y-1">
            <span className="text-sm font-medium">{label}</span>
            <Stepper
              label={label}
              min={0}
              value={values[m] ?? ''}
              onChange={(v) => setValues({ ...values, [m]: v })}
            />
          </div>
        ))}
      </div>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={secondaryButton}>
        Save the totals
      </button>
    </form>
  );
}

/** A room's breakfast that day: add one, change one, or 0 to take it off (ADR 094). */
export function BreakfastRoomForm({
  day,
  rooms,
}: {
  day: string;
  rooms: { room_id: string; number: string; floor: string | null }[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [room, setRoom] = useState('');
  const [mode, setMode] = useState('in_room');
  const [guests, setGuests] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      setError(null);
      if (!room) return setError('Tap the room.');
      if (guests.trim() === '') return setError('Say how many guests.');
      const r = await setBreakfastRoom(room, day, mode, Number(guests), note);
      if (!r.ok) return setError(r.message);
      setRoom('');
      setGuests('');
      setNote('');
      router.refresh();
    });
  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h2 className="font-semibold">A room</h2>
      <div role="group" aria-label="Room" className="space-y-2">
        {byFloor(rooms).map((f) => (
          <div key={f.floor} className="grid grid-cols-5 gap-2">
            {f.rooms.map((r) => (
              <button
                key={r.room_id}
                type="button"
                aria-pressed={room === r.room_id}
                aria-label={`Room ${r.number}`}
                onClick={() => setRoom(r.room_id)}
                className={`min-h-12 rounded-lg text-base font-bold tabular-nums ring-1 ${
                  room === r.room_id
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
      <div className="space-y-1">
        <span className="text-sm font-medium">Guests</span>
        <Stepper label="Guests" min={0} start={1} value={guests} onChange={setGuests} />
      </div>
      <div role="group" aria-label="Where" className="grid grid-cols-2 gap-2">
        {MODES.map(([m, label]) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={`flex min-h-12 items-center justify-center gap-2 rounded-xl text-base font-semibold ring-1 ${
              mode === m
                ? 'bg-brand-700 text-white ring-brand-700'
                : 'bg-white text-slate-800 ring-slate-300'
            }`}
          >
            <Icon name={m === 'in_room' ? 'bed' : 'plate'} className="size-5" />
            {label}
          </button>
        ))}
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Save the room
      </button>
    </form>
  );
}
