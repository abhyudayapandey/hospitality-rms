'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { ItemThumb } from '@/components/item-thumb';
import { useHydrated } from '@/lib/use-hydrated';
import { issueUniform, recordLaundry, returnUniform } from './actions';

/** The day's laundry exchange (ADR 094): how many of each went soiled and came back fresh. */
export function LaundryForm({
  place,
  day,
  items,
}: {
  place: string;
  day: string;
  items: { item_id: string; name: string }[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [v, setV] = useState<Record<string, { sent: string; received: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (id: string, k: 'sent' | 'received', val: string) =>
    setV({ ...v, [id]: { sent: v[id]?.sent ?? '', received: v[id]?.received ?? '', [k]: val } });
  const save = () =>
    start(async () => {
      setError(null);
      const lines = items
        .filter((i) => (v[i.item_id]?.sent ?? '') !== '' || (v[i.item_id]?.received ?? '') !== '')
        .map((i) => ({
          item_id: i.item_id,
          sent: Number(v[i.item_id]?.sent || 0),
          received: Number(v[i.item_id]?.received || 0),
        }));
      if (lines.length === 0) return setError('Enter what went or came back.');
      const r = await recordLaundry(place, day, lines);
      if (!r.ok) return setError(r.message);
      setV({});
      router.refresh();
    });
  if (items.length === 0) return <p className="text-sm text-slate-600">No linen is kept here.</p>;
  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h2 className="font-semibold">Today with the laundry</h2>
      <ul className="divide-y divide-slate-100">
        {items.map((i) => (
          // the name on its own line and the two numbers under it, labelled, so a long name
          // never squeezes the inputs at 380px
          <li key={i.item_id} className="space-y-2 py-3" data-testid="laundry-line">
            <span className="flex items-center gap-3">
              <ItemThumb name={i.name} size="size-8" />
              <span className="min-w-0 flex-1 text-sm font-medium break-words">{i.name}</span>
            </span>
            <span className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Sent to laundry</span>
                <input
                  inputMode="numeric"
                  aria-label={`${i.name} sent`}
                  value={v[i.item_id]?.sent ?? ''}
                  onChange={(e) => set(i.item_id, 'sent', e.target.value)}
                  className={`${inputClass} text-right`}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Came back</span>
                <input
                  inputMode="numeric"
                  aria-label={`${i.name} back`}
                  value={v[i.item_id]?.received ?? ''}
                  onChange={(e) => set(i.item_id, 'received', e.target.value)}
                  className={`${inputClass} text-right`}
                />
              </label>
            </span>
          </li>
        ))}
      </ul>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Save today&apos;s exchange
      </button>
    </form>
  );
}

/** Issue a uniform to someone at the outlet (ADR 094). */
export function UniformForm({
  place,
  people,
}: {
  place: string;
  people: { id: string; name: string }[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [person, setPerson] = useState('');
  const [item, setItem] = useState('');
  const [size, setSize] = useState('');
  const [qty, setQty] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      setError(null);
      if (!person) return setError('Choose who it is for.');
      if (!item.trim()) return setError('Say what was issued.');
      if (!(Number(qty) > 0)) return setError('Say how many.');
      const r = await issueUniform({ place, person, item, size, qty: Number(qty) });
      if (!r.ok) return setError(r.message);
      setItem('');
      setSize('');
      setQty('');
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
      <h2 className="font-semibold">Issue a uniform</h2>
      <label className="block space-y-1">
        <span className="text-sm font-medium">To</span>
        <select value={person} onChange={(e) => setPerson(e.target.value)} className={inputClass}>
          <option value="">Choose…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">What</span>
        <input value={item} onChange={(e) => setItem(e.target.value)} className={inputClass} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Size</span>
          <input value={size} onChange={(e) => setSize(e.target.value)} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">How many</span>
          <input
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Issue
      </button>
    </form>
  );
}

export function ReturnUniform({ id }: { id: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    // a fixed width beside the uniform's line: the shared button is full width
    <span className="block w-28 shrink-0 space-y-1">
      <button
        type="button"
        disabled={!hydrated || pending}
        className={secondaryButton}
        onClick={() =>
          start(async () => {
            const r = await returnUniform(id);
            if (!r.ok) setError(r.message);
            else router.refresh();
          })
        }
      >
        Returned
      </button>
      <ErrorBox message={error} />
    </span>
  );
}
