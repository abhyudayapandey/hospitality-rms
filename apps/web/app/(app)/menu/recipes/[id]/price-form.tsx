'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { setPrice } from '../../actions';
import { DateInput } from '@/components/date-time-inputs';
import { callAction } from '@/lib/call-action';
import { useTimeZone } from '@/components/time-zone';
import { localToday } from '@/lib/dates';

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
  const tz = useTimeZone();
  const router = useRouter();
  const hydrated = useHydrated();
  const [value, setValue] = useState(String(Number(price)));
  const [from, setFrom] = useState(() => localToday(tz));
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
          const r = await callAction(setPrice, menuItemId, outletId, n, from);
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
        <DateInput
          className={inputClass}
          min={localToday(tz)}
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
