'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { PhotoField } from '@/components/photo-field';
import type { Person } from '@/lib/tasks';
import { useHydrated } from '@/lib/use-hydrated';
import {
  assignMaintenance,
  closeMaintenance,
  getMaintenanceUploadUrl,
  raiseMaintenance,
  startMaintenance,
} from '../actions';

/** Anyone reports a problem where they work, with a photo if they like. */
export function ReportForm({ place, photos }: { place: string; photos: boolean }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    start(async () => {
      setError(null);
      if (!title.trim()) return setError('Say what is wrong.');
      const r = await raiseMaintenance({
        place,
        title,
        description,
        photoKey,
        idempotencyKey: key,
      });
      if (!r.ok) return setError(r.message);
      router.push(`/tasks/maintenance/${r.data.id}`);
    });
  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">What is wrong</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Details (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`${inputClass} min-h-20 py-2`}
        />
      </label>
      {photos && (
        <PhotoField
          node={place}
          photoKey={photoKey}
          onChange={setPhotoKey}
          getUploadUrl={getMaintenanceUploadUrl}
          label="Problem photo"
        />
      )}
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
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
          Photo upload isn&apos;t set up here, so this can&apos;t be closed.
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
