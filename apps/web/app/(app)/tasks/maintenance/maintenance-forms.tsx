'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { Icon, type IconName } from '@/components/icon';
import { PhotoField } from '@/components/photo-field';
import { byFloor } from '@/lib/rooms-view';
import type { Person } from '@/lib/tasks';
import { useHydrated } from '@/lib/use-hydrated';
import {
  assignMaintenance,
  closeMaintenance,
  getMaintenanceUploadUrl,
  raiseMaintenance,
  startMaintenance,
} from '../actions';

// What is wrong, as pictures (ADR 113): most problems are one of these
const WHAT: readonly { word: string; icon: IconName }[] = [
  { word: 'Leak', icon: 'tap' },
  { word: 'No power', icon: 'bulb' },
  { word: 'AC or fridge', icon: 'fridge' },
  { word: 'Broken', icon: 'wrench' },
  { word: 'Pests', icon: 'alert' },
  { word: 'Other', icon: 'dots' },
];

/**
 * Anyone reports a problem where they work (ADR 113): a photo first, then what is wrong and
 * where as taps, a room by its number; a note only if they want one.
 */
export function ReportForm({
  place,
  places,
  rooms,
  photos,
}: {
  place: string;
  /** the places they may report at, as "where" chips (short names) */
  places: { id: string; name: string }[];
  /** the outlet's rooms, when it has them */
  rooms: { room_id: string; number: string; floor: string | null }[];
  photos: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [what, setWhat] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [where, setWhere] = useState(place);
  const [room, setRoom] = useState<string | null>(null);
  const [inRoom, setInRoom] = useState(false);
  const [description, setDescription] = useState('');
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const title =
    what === 'Other' ? other.trim() : what ? `${what}${room ? ` in room ${room}` : ''}` : '';
  const submit = () =>
    start(async () => {
      setError(null);
      if (!title) return setError('Say what is wrong.');
      const r = await raiseMaintenance({
        place: where,
        title: what === 'Other' && room ? `${title} (room ${room})` : title,
        description,
        photoKey,
        idempotencyKey: key,
      });
      if (!r.ok) return setError(r.message);
      router.push(`/tasks/maintenance/${r.data.id}`);
    });
  const chip = (on: boolean) =>
    `flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium ring-1 ${
      on ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white text-slate-800 ring-slate-300'
    }`;
  return (
    <form
      className="space-y-4 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {photos && (
        <PhotoField
          node={where}
          photoKey={photoKey}
          onChange={setPhotoKey}
          getUploadUrl={getMaintenanceUploadUrl}
          label="Problem photo"
        />
      )}
      <div role="group" aria-label="What is wrong" className="space-y-2">
        <span className="text-sm font-medium">What</span>
        <div className="grid grid-cols-3 gap-2">
          {WHAT.map((w) => (
            <button
              key={w.word}
              type="button"
              aria-pressed={what === w.word}
              onClick={() => setWhat(w.word)}
              className={`flex min-h-18 flex-col items-center justify-center gap-1 rounded-xl text-sm font-medium ring-1 ${
                what === w.word
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-800 ring-slate-300'
              }`}
            >
              <Icon name={w.icon} className="size-6" />
              {w.word}
            </button>
          ))}
        </div>
        {what === 'Other' && (
          <label className="block space-y-1">
            <span className="text-sm font-medium">What is wrong</span>
            <input
              value={other}
              onChange={(e) => setOther(e.target.value)}
              className={inputClass}
            />
          </label>
        )}
      </div>
      {(places.length > 1 || rooms.length > 0) && (
        <div role="group" aria-label="Where" className="space-y-2">
          <span className="text-sm font-medium">Where</span>
          <div className="flex flex-wrap gap-2">
            {places.length > 1 &&
              places.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={where === p.id && !inRoom}
                  onClick={() => {
                    setWhere(p.id);
                    setInRoom(false);
                    setRoom(null);
                  }}
                  className={chip(where === p.id && !inRoom)}
                >
                  {p.name}
                </button>
              ))}
            {rooms.length > 0 && (
              <button
                type="button"
                aria-pressed={inRoom}
                onClick={() => setInRoom(true)}
                className={chip(inRoom)}
              >
                <Icon name="bed" className="size-4" />A room
              </button>
            )}
          </div>
          {inRoom && (
            <div role="group" aria-label="Room" className="space-y-2">
              {byFloor(rooms).map((f) => (
                <div key={f.floor} className="grid grid-cols-5 gap-2">
                  {f.rooms.map((r) => (
                    <button
                      key={r.room_id}
                      type="button"
                      aria-pressed={room === r.number}
                      aria-label={`Room ${r.number}`}
                      onClick={() => setRoom(r.number)}
                      className={`min-h-12 rounded-lg text-base font-bold tabular-nums ring-1 ${
                        room === r.number
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
          )}
        </div>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-medium">Note (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`${inputClass} min-h-20 py-2`}
        />
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending || !title} className={primaryButton}>
        Send to maintenance
      </button>
    </form>
  );
}

/** The Engineering head (or the outlet manager) gives the request to someone. */
export function AssignRepair({
  id,
  people,
  current,
}: {
  id: string;
  people: Person[];
  current: string | null;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [user, setUser] = useState(current ?? people[0]?.user_id ?? '');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
      <h2 className="font-semibold">{current ? 'Reassign' : 'Assign'}</h2>
      <select
        aria-label="Technician"
        value={user}
        onChange={(e) => setUser(e.target.value)}
        className={inputClass}
      >
        {people.map((p) => (
          <option key={p.user_id} value={p.user_id}>
            {p.name}
            {p.job_role ? ` (${p.job_role})` : ''}
          </option>
        ))}
      </select>
      <ErrorBox message={error} />
      <button
        type="button"
        disabled={!hydrated || pending || !user}
        className={primaryButton}
        onClick={() =>
          start(async () => {
            const r = await assignMaintenance(id, user);
            if (!r.ok) setError(r.message);
            else router.refresh();
          })
        }
      >
        Assign
      </button>
    </section>
  );
}

/** The assignee starts the repair, then closes it with a photo of the fix. */
export function WorkRepair({
  id,
  node,
  status,
  photos,
}: {
  id: string;
  node: string;
  status: 'assigned' | 'in_progress';
  photos: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [note, setNote] = useState('');
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.message ?? null);
      else router.refresh();
    });
  return (
    <section className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200">
      {status === 'assigned' && (
        <button
          type="button"
          disabled={!hydrated || pending}
          className={secondaryButton}
          onClick={() => act(() => startMaintenance(id))}
        >
          Start the repair
        </button>
      )}
      <h2 className="font-semibold">Close with a photo</h2>
      {photos ? (
        <PhotoField
          node={node}
          photoKey={photoKey}
          onChange={setPhotoKey}
          getUploadUrl={getMaintenanceUploadUrl}
          label="Photo of the fix"
        />
      ) : (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Photos can&apos;t be taken here right now. Tell your manager.
        </p>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-medium">What you did</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
      </label>
      <ErrorBox message={error} />
      <button
        type="button"
        disabled={!hydrated || pending || !photoKey}
        className={primaryButton}
        onClick={() => act(() => closeMaintenance(id, photoKey, note))}
      >
        Mark fixed
      </button>
    </section>
  );
}
