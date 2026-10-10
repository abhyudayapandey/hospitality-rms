'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, primaryButton } from '@/components/messages';
import { ItemPicker } from '@/components/item-picker';
import { formatQty } from '@/lib/qty';
import { packAmount, packCount } from '@/lib/pack';
import { Stepper } from '@/components/stepper';
import { useHydrated } from '@/lib/use-hydrated';
import { openPack } from '../actions';

export interface PackOption {
  item_id: string;
  name: string;
  base_uom: string;
  hours: number;
  on_hand: string;
  pack_size: string | null;
  pack_name: string | null;
}

const keeps = (h: number) => (h % 24 === 0 ? `${h / 24} days` : `${h} hours`);

/**
 * Open a pack (ADR 093): which item and how much; it keeps its shelf life from now, and its
 * label opens to print. An item with a pack size is opened by whole packs (ADR 102): "How
 * many?" from 1, "1 tin = 400 ml", and the quantity is packs × the pack size. An item with
 * none takes any amount, nothing filled in.
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
  const [packs, setPacks] = useState('1');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const item = items.find((i) => i.item_id === itemId);

  const submit = () =>
    start(async () => {
      setError(null);
      if (!item) return setError('Choose what you opened.');
      const many = Number(packs);
      if (item.pack_size && (!Number.isInteger(many) || many <= 0)) {
        return setError('Say how many you opened.');
      }
      const n = item.pack_size ? many * Number(item.pack_size) : Number(qty);
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
      {/* what has a shelf life once opened, as pictures (ADR 113) */}
      <ItemPicker
        items={items}
        value={itemId || null}
        onChange={(id) => setItemId(id ?? '')}
        label="What you opened"
      />
      {item && (
        <p className="text-sm text-slate-600" data-testid="pack-keeps">
          Keeps {keeps(item.hours)} once opened. The store has{' '}
          {formatQty(item.on_hand, item.base_uom)}.
        </p>
      )}
      {item?.pack_size ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">How many?</p>
          <p className="text-sm text-slate-600" data-testid="pack-size">
            {packCount(1, item.pack_name)} = {packAmount(item.pack_size, item.base_uom)}
          </p>
          <Stepper
            label={`How many ${item.name}`}
            value={packs}
            onChange={(v) => setPacks(v.replace(/[^0-9]/g, ''))}
            min={1}
            testId="pack-count"
            unit={packCount(Number(packs) || 2, item.pack_name).replace(/^\d+ /, '')}
          />
        </div>
      ) : item ? (
        <div className="space-y-1">
          <span className="text-sm font-medium">How much ({item.base_uom})</span>
          <Stepper label={`How much (${item.base_uom})`} value={qty} onChange={setQty} min={0} />
        </div>
      ) : null}
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending || !item} className={primaryButton}>
        Open and print the label
      </button>
    </form>
  );
}
