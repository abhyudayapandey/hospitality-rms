'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { ItemThumb } from '@/components/item-thumb';
import { Stepper } from '@/components/stepper';
import { useHydrated } from '@/lib/use-hydrated';
import { issueUniform, recordLaundry, returnUniform } from './actions';

/** Today's row for an item: what the day already has, added to, never replaced (ADR 113). */
export interface LaundryToday {
  item_id: string;
  sent: number;
  received: number;
}

/**
 * Sending to the laundry (ADR 094, 113): only what goes out, each item a − / + with nothing
 * filled in. Added to what today already sent.
 */
export function SendForm({
  place,
  day,
  items,
  today,
}: {
  place: string;
  day: string;
  items: { item_id: string; name: string }[];
  today: LaundryToday[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [v, setV] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = () =>
    start(async () => {
      setError(null);
      const lines = items
        .filter((i) => Number(v[i.item_id] || 0) > 0)
        .map((i) => {
          const t = today.find((x) => x.item_id === i.item_id);
          return {
            item_id: i.item_id,
            sent: (t?.sent ?? 0) + Number(v[i.item_id]),
            received: t?.received ?? 0,
          };
        });
      if (lines.length === 0) return setError('Enter what goes to the laundry.');
      const r = await recordLaundry(place, day, lines);
      if (!r.ok) return setError(r.message);
      setV({});
      setSaved(true);
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
      <ul className="divide-y divide-slate-100">
        {items.map((i) => (
          // the name on its own line and the number under it, so a long name never squeezes it
          <li key={i.item_id} className="space-y-2 py-3" data-testid="laundry-line">
            <span className="flex items-center gap-3">
              <ItemThumb name={i.name} size="size-8" />
              <span className="min-w-0 flex-1 text-sm font-medium break-words">{i.name}</span>
            </span>
            <Stepper
              value={v[i.item_id] ?? ''}
              onChange={(x) => {
                setV({ ...v, [i.item_id]: x });
                setSaved(false);
              }}
              label={`${i.name} sent`}
              min={0}
            />
          </li>
        ))}
      </ul>
      <ErrorBox message={error} />
      {saved && !pending && (
        <p role="status" className="text-sm font-semibold text-emerald-700">
          Sent.
        </p>
      )}
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Save what went out
      </button>
    </form>
  );
}

/**
 * What came back (ADR 113): each item still at the laundry, with how many and since when, and a
 * − / + for what came back; less than went out says how many are short.
 */
export function ReceiveForm({
  place,
  day,
  out,
  today,
}: {
  place: string;
  day: string;
  out: { item_id: string; name: string; at_laundry: number; since: string | null }[];
  today: LaundryToday[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [v, setV] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      setError(null);
      const lines = out
        .filter((i) => Number(v[i.item_id] || 0) > 0)
        .map((i) => {
          const t = today.find((x) => x.item_id === i.item_id);
          return {
            item_id: i.item_id,
            sent: t?.sent ?? 0,
            received: (t?.received ?? 0) + Number(v[i.item_id]),
          };
        });
      if (lines.length === 0) return setError('Enter what came back.');
      const r = await recordLaundry(place, day, lines);
      if (!r.ok) return setError(r.message);
      setV({});
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
      <ul className="divide-y divide-slate-100">
        {out.map((i) => {
          const back = Number(v[i.item_id] || 0);
          const short = back > 0 && back < i.at_laundry ? i.at_laundry - back : 0;
          return (
            <li key={i.item_id} className="space-y-2 py-3" data-testid="receive-line">
              <span className="flex items-center gap-3">
                <ItemThumb name={i.name} size="size-8" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium break-words">{i.name}</span>
                  <span className="block text-xs text-slate-500 tabular-nums">
                    {i.at_laundry} out{i.since ? ` since ${i.since}` : ''}
                  </span>
                </span>
                {short > 0 && (
                  <span
                    className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800"
                    data-testid="receive-short"
                  >
                    {short} short
                  </span>
                )}
              </span>
              <Stepper
                value={v[i.item_id] ?? ''}
                onChange={(x) => setV({ ...v, [i.item_id]: x })}
                label={`${i.name} back`}
                min={0}
              />
            </li>
          );
        })}
      </ul>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Save what came back
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
