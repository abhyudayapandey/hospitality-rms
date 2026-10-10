'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { ItemThumb } from '@/components/item-thumb';
import { formatQty } from '@/lib/qty';
import { useHydrated } from '@/lib/use-hydrated';
import { openPack } from '../actions';

export interface PackOption {
  item_id: string;
  name: string;
  base_uom: string;
  hours: number;
  on_hand: string;
}

const keeps = (h: number) => (h % 24 === 0 ? `${h / 24} days` : `${h} hours`);

/**
 * Open a pack (ADR 093): which item and how much; it keeps its shelf life from now, and its
 * label opens to print. Nothing is filled in.
 */
export function OpenPackForm({
  node,
  items,
  initial,
}: {
  node: string;
  items: PackOption[];
  /** the item chosen on its page ("Open a pack") */
  initial?: string | undefined;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [itemId, setItemId] = useState(() =>
    items.some((i) => i.item_id === initial) ? initial! : '',
  );
  const [qty, setQty] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const item = items.find((i) => i.item_id === itemId);

  const submit = () =>
    start(async () => {
      setError(null);
      const n = Number(qty);
      if (!item) return setError('Choose what you opened.');
      if (!Number.isFinite(n) || n <= 0) return setError('Enter how much you opened.');
      const r = await openPack(node, item.item_id, n, key);
      if (!r.ok) return setError(r.message);
      setKey(crypto.randomUUID());
      router.push(`/stock/opened/label/${r.data.id}`);
    });

  if (items.length === 0) {
    return (
      <p className="text-sm text-slate-600">Nothing kept here has a shelf life once opened.</p>
    );
  }
  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 className="font-semibold">Open a pack</h2>
      <label className="block space-y-1">
        <span className="text-sm font-medium">What you opened</span>
        <span className="flex items-center gap-3">
          {item && <ItemThumb name={item.name} />}
          <select value={itemId} onChange={(e) => setItemId(e.target.value)} className={inputClass}>
            <option value="">Choose…</option>
            {items.map((i) => (
              <option key={i.item_id} value={i.item_id}>
                {i.name} ({i.base_uom})
              </option>
            ))}
          </select>
        </span>
      </label>
      {item && (
        <p className="text-sm text-slate-600" data-testid="pack-keeps">
          Keeps {keeps(item.hours)} once opened. The store has{' '}
          {formatQty(item.on_hand, item.base_uom)}.
        </p>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-medium">How much ({item?.base_uom ?? 'in its unit'})</span>
        <input
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className={inputClass}
        />
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Open and print the label
      </button>
    </form>
  );
}
