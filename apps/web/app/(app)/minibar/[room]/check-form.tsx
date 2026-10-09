'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  ErrorBox,
  StatusBox,
  inputClass,
  primaryButton,
  secondaryButton,
} from '@/components/messages';
import { formatMoney } from '@/lib/format';
import { inputQty } from '@/lib/qty';
import { useHydrated } from '@/lib/use-hydrated';
import { checkMinibar } from '../actions';
import { ItemThumb } from '@/components/item-thumb';

interface Item {
  id: string;
  name: string;
  unit: string;
  par: number;
  price: string;
  inStore: number;
}

/** What is left of each item, nothing filled in (ADR 053); "All there" when nothing was used. */
export function CheckForm({ room, items }: { room: string; items: Item[] }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [left, setLeft] = useState<Record<string, string>>({});
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const used = items.map((i) => {
    const v = left[i.id];
    const n = v === undefined || v === '' ? null : Number(v);
    return { ...i, left: n, used: n === null || Number.isNaN(n) ? 0 : Math.max(i.par - n, 0) };
  });
  const charge = used.reduce((s, i) => s + i.used * Number(i.price), 0);
  const missing = used.filter((i) => i.left === null || Number.isNaN(i.left)).length;

  const save = () =>
    start(async () => {
      setError(null);
      setStatus(null);
      if (missing > 0) return setError('Count every item: put 0 for one that is gone.');
      const r = await checkMinibar({
        room,
        lines: used.map((i) => ({ item_id: i.id, left: i.left! })),
        idempotencyKey: key,
      });
      if (!r.ok) return setError(r.message);
      setKey(crypto.randomUUID());
      setLeft({});
      setStatus(
        charge > 0
          ? `Saved. ${formatMoney(charge)} to add to the guest's bill. Refill it from your To do list.`
          : 'Saved. Nothing was used.',
      );
      router.refresh();
    });

  return (
    <form
      aria-label="Minibar check"
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <button
        type="button"
        className={secondaryButton}
        onClick={() => setLeft(Object.fromEntries(items.map((i) => [i.id, inputQty(i.par)])))}
      >
        All there: nothing used
      </button>
      <ul className="divide-y divide-slate-100">
        {used.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-3 py-2">
            <ItemThumb name={i.name} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{i.name}</span>
              <span className="block text-xs text-slate-500">
                par {i.par} · {formatMoney(i.price)} each
                {i.inStore < i.par && ` · store has ${inputQty(i.inStore)}`}
              </span>
            </span>
            <label className="flex shrink-0 items-center gap-2 text-sm">
              <span className="text-slate-500">left</span>
              <input
                inputMode="decimal"
                aria-label={`Left: ${i.name}`}
                value={left[i.id] ?? ''}
                onChange={(e) => setLeft({ ...left, [i.id]: e.target.value })}
                className={`${inputClass} max-w-20 text-right`}
              />
            </label>
          </li>
        ))}
      </ul>
      <p className="text-sm" data-testid="minibar-charge-preview">
        {charge > 0 ? `To charge: ${formatMoney(charge)}` : 'Nothing to charge yet'}
      </p>
      <ErrorBox message={error} />
      <StatusBox message={status} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Save
      </button>
    </form>
  );
}
