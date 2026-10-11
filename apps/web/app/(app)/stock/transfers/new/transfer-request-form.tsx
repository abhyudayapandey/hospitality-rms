'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ListSearch } from '@/components/list-search';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import type { ItemOption } from '@/lib/inventory';
import { UnusualNote } from '@/components/unusual-note';
import { askForStock } from '../../actions';
import { formatQty } from '@/lib/qty';
import { ItemThumb } from '@/components/item-thumb';

export interface AskItem extends ItemOption {
  /** the store it comes from; null: no other store keeps it, so it is bought */
  source_id: string | null;
  source_name: string | null;
  source_on_hand: string;
}

/**
 * Ask for stock (ADR 115): items by the store they come from, short ones first; a quantity for
 * each wanted, nothing filled in (ADR 053). One tap asks every store at once.
 */
export function TransferRequestForm({ to, items }: { to: string; items: AskItem[] }) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const askable = items.filter((i) => i.source_id);
  const bought = items.filter((i) => !i.source_id);
  const lines = askable
    .map((i) => ({ item_id: i.item_id, qty: Number(qty[i.item_id]) }))
    .filter((l) => qty[l.item_id]?.trim() && l.qty > 0);
  const short = (i: AskItem) => Number(i.par_level ?? 0) > Number(i.on_hand);
  // by the store it comes from, short items first in each
  const sources = [...new Set(askable.map((i) => i.source_name!))].map((name) => ({
    name,
    rows: askable
      .filter((i) => i.source_name === name)
      .sort((a, b) => Number(short(b)) - Number(short(a))),
  }));

  const submit = () =>
    start(async () => {
      setError(null);
      const r = await askForStock(to, lines, note, key);
      if (!r.ok) setError(r.message);
      else if (r.data.ids.length === 1) router.push(`/stock/transfers/${r.data.ids[0]}?node=${to}`);
      else router.push(`/stock/transfers?node=${to}`);
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div id="transfer-lines" className="space-y-3">
        {askable.length === 0 && (
          <p className="text-sm text-slate-600" data-testid="nothing-to-ask">
            No other store here keeps what this store uses.
          </p>
        )}
        <ListSearch scope="transfer-lines" count={askable.length} noun="items" />
        {sources.map((g) => (
          <section key={g.name} className="space-y-1" data-testid={`from-${g.name}`}>
            <h2 className="text-sm font-semibold text-slate-500">From the {g.name}</h2>
            <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
              {g.rows.map((i) => (
                <li
                  key={i.item_id}
                  className="flex items-center justify-between gap-3 px-4 py-2"
                  data-filter-row
                  data-filter-text={i.name}
                >
                  <ItemThumb name={i.name} />
                  <label htmlFor={`t-${i.item_id}`} className="min-w-0 flex-1 text-sm">
                    <span className="block font-medium">{i.name}</span>
                    <span className={`text-xs ${short(i) ? 'text-amber-800' : 'text-slate-500'}`}>
                      here {formatQty(i.on_hand, i.base_uom)}
                      {Number(i.par_level ?? 0) > 0 &&
                        ` · par ${formatQty(i.par_level!, i.base_uom)}`}
                      {` · ${g.name} has ${formatQty(i.source_on_hand, i.base_uom)}`}
                    </span>
                  </label>
                  <input
                    id={`t-${i.item_id}`}
                    aria-label={`Ask for ${i.name}`}
                    inputMode="decimal"
                    value={qty[i.item_id] ?? ''}
                    onChange={(e) => setQty((v) => ({ ...v, [i.item_id]: e.target.value }))}
                    className={`${inputClass} max-w-24 text-right`}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {bought.length > 0 && (
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700" data-testid="bought-here">
          No other store here keeps{' '}
          {bought.length === 1 ? bought[0]!.name : `${bought.length} of your items`}:{' '}
          <Link href={`/stock/orders/new?node=${to}`} className="font-medium underline">
            ask to buy {bought.length === 1 ? 'it' : 'them'}
          </Link>
          .
        </p>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-medium">What it is for (optional)</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="For the room minibars"
          className={inputClass}
        />
      </label>
      <UnusualNote node={to} kind="transfer" lines={lines} />
      <ErrorBox message={error} />
      <button
        type="submit"
        disabled={!hydrated || pending || lines.length === 0}
        className={primaryButton}
      >
        {lines.length === 0
          ? 'Add how many you need'
          : `Ask for ${lines.length} item${lines.length === 1 ? '' : 's'}`}
      </button>
    </form>
  );
}
