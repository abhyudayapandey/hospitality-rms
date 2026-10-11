'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton } from '@/components/messages';
import { byFloor, floorName } from '@/lib/rooms-view';
import { useHydrated } from '@/lib/use-hydrated';
import { giveRooms } from '../actions';

/** Pick a person, tap their rooms (others' rooms show whose they are), save (ADR 111). */
export function GiveRoomsForm({
  outlet,
  day,
  people,
  rooms,
  given,
}: {
  outlet: string;
  day: string;
  people: { user_id: string; name: string; role_name: string }[];
  rooms: { room_id: string; number: string; floor: string | null }[];
  given: { room_id: string; user_id: string; name: string }[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [person, setPerson] = useState<string>(people[0]!.user_id);
  const [owner, setOwner] = useState<Record<string, string>>(
    Object.fromEntries(given.map((g) => [g.room_id, g.user_id])),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const name = (id: string) => people.find((p) => p.user_id === id)?.name ?? '';
  const first = (id: string) => name(id).split(/\s+/)[0] ?? '';
  const theirs = rooms.filter((r) => owner[r.room_id] === person);

  const tap = (room: string) => {
    setSaved(null);
    setOwner((o) => {
      const next = { ...o };
      if (next[room] === person) delete next[room];
      else next[room] = person;
      return next;
    });
  };

  const save = () =>
    start(async () => {
      setError(null);
      const r = await giveRooms(
        outlet,
        day,
        person,
        theirs.map((x) => x.room_id),
      );
      if (!r.ok) return setError(r.message);
      setSaved(`${first(person)} has ${theirs.length} ${theirs.length === 1 ? 'room' : 'rooms'}.`);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Person" className="flex flex-wrap gap-2">
        {people.map((p) => {
          const n = Object.values(owner).filter((u) => u === p.user_id).length;
          return (
            <button
              key={p.user_id}
              type="button"
              aria-pressed={person === p.user_id}
              onClick={() => {
                setPerson(p.user_id);
                setSaved(null);
              }}
              className={`min-h-12 rounded-xl px-3 text-left ring-1 ${
                person === p.user_id
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-800 ring-slate-300'
              }`}
            >
              <span className="block font-semibold">{p.name}</span>
              <span className="block text-xs opacity-80">
                {p.role_name} · {n} {n === 1 ? 'room' : 'rooms'}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-sm text-slate-600">
        Tap {first(person)}&apos;s rooms. A room someone else has moves to {first(person)}.
      </p>
      {byFloor(rooms).map((f) => (
        <section key={f.floor} className="space-y-2" aria-label={floorName(f.floor)}>
          <h2 className="text-sm font-semibold text-slate-500">{floorName(f.floor)}</h2>
          <div className="grid grid-cols-4 gap-2">
            {f.rooms.map((r) => {
              const o = owner[r.room_id];
              const isTheirs = o === person;
              return (
                <button
                  key={r.room_id}
                  type="button"
                  aria-pressed={isTheirs}
                  aria-label={`Room ${r.number}${o && !isTheirs ? `, ${name(o)}'s` : ''}`}
                  onClick={() => tap(r.room_id)}
                  data-testid="give-room"
                  className={`flex min-h-16 flex-col items-center justify-center rounded-xl ring-1 ${
                    isTheirs
                      ? 'bg-brand-700 text-white ring-brand-700'
                      : o
                        ? 'bg-slate-100 text-slate-500 ring-slate-300'
                        : 'bg-white text-slate-800 ring-slate-300'
                  }`}
                >
                  <span className="text-lg font-bold tabular-nums">{r.number}</span>
                  {o && !isTheirs && <span className="text-[11px] font-semibold">{first(o)}</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <ErrorBox message={error} />
      {saved && (
        <p role="status" className="text-sm font-semibold text-emerald-700">
          {saved}
        </p>
      )}
      <button
        type="button"
        onClick={save}
        disabled={!hydrated || pending}
        className={primaryButton}
      >
        Give {first(person)} {theirs.length} {theirs.length === 1 ? 'room' : 'rooms'}
      </button>
    </div>
  );
}
