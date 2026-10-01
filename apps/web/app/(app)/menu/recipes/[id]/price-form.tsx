'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { setPrice } from '../../actions';

const today = () => new Date().toISOString().slice(0, 10);

export function PriceForm({
  menuItemId,
  outletId,
  outletName,
  price,
}: {
  menuItemId: string;
  outletId: string;
  outletName: string;
  price: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [value, setValue] = useState(String(Number(price)));
  const [from, setFrom] = useState(today);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          setDone(null);
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) {
            setError('Enter a price of zero or more.');
            return;
          }
          const r = await setPrice(menuItemId, outletId, n, from);
          if (!r.ok) setError(r.message);
          else {
            setDone(`Price saved from ${from}.`);
            router.refresh();
          }
        });
      }}
    >
      <h2 className="font-semibold">Price at {outletName}</h2>
      <label className="block space-y-1">
        <span className="text-sm">Price before tax (₹)</span>
        <input
          className={inputClass}
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          name="price"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm">From</span>
        <input
          className={inputClass}
          type="date"
          min={today()}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button className={primaryButton} disabled={!hydrated || pending}>
        {pending ? 'Saving…' : 'Save price'}
      </button>
    </form>
  );
}
