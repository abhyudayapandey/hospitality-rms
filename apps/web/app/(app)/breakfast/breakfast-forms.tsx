'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
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
      <div className="grid grid-cols-2 gap-3">
        {MODES.map(([m, label]) => (
          <label key={m} className="block space-y-1">
            <span className="text-sm font-medium">{label}</span>
            <input
              inputMode="numeric"
              value={values[m] ?? ''}
              onChange={(e) => setValues({ ...values, [m]: e.target.value })}
              className={inputClass}
            />
          </label>
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
  rooms: { room_id: string; number: string }[];
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
      if (!room) return setError('Choose the room.');
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
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Room</span>
          <select value={room} onChange={(e) => setRoom(e.target.value)} className={inputClass}>
            <option value="">Choose…</option>
            {rooms.map((r) => (
              <option key={r.room_id} value={r.room_id}>
                {r.number}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Guests</span>
          <input
            inputMode="numeric"
            value={guests}
            onChange={(e) => setGuests(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Where</span>
        <select value={mode} onChange={(e) => setMode(e.target.value)} className={inputClass}>
          {MODES.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
        </select>
      </label>
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
