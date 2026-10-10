'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { addPermit } from './actions';

/** A transport permit for liquor that arrived (ADR 096); FOC bottles go in the note. */
export function PermitForm({ store, today }: { store: string; today: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [no, setNo] = useState('');
  const [day, setDay] = useState(today);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      setError(null);
      if (!no.trim()) return setError('Enter the permit number.');
      const r = await addPermit(store, no, day, note);
      if (!r.ok) return setError(r.message);
      setNo('');
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
      <h2 className="font-semibold">A transport permit</h2>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Permit number</span>
        <input value={no} onChange={(e) => setNo(e.target.value)} className={inputClass} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Received on</span>
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Note (optional, e.g. FOC bottles)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Keep the permit
      </button>
    </form>
  );
}
