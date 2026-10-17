'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ItemThumb } from '@/components/item-thumb';
import { ListSearch } from '@/components/list-search';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { Stepper } from '@/components/stepper';
import { shortFirst } from '@/lib/short-first';
import { useHydrated } from '@/lib/use-hydrated';
import { raiseStaffAsk } from '../../actions';
import { callAction } from '@/lib/call-action';

export interface AskStoreItem {
  item_id: string;
  name: string;
  base_uom: string;
  on_hand: string;
  category: string | null;
  par: string;
}

/**
 * Tap − / + for how many of each; nothing filled in (ADR 098). What the store runs short of comes
 * first, then the rest by category, as on Ask for supplies (ADR 101, 153). One button sends it to
 * the head of the department.
 */
export function AskForm({
  stores,
  store,
  items,
  hotel = false,
}: {
  stores: { id: string; name: string }[];
  store: { id: string; name: string };
  items: AskStoreItem[];
  /** a hotel's note gives a room as its example, elsewhere a table */
  hotel?: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const lines = items
    .map((i) => ({ item_id: i.item_id, qty: Number(qty[i.item_id]) }))
    .filter((l) => l.qty > 0);
  const submit = () =>
    start(async () => {
      setError(null);
      const r = await callAction(raiseStaffAsk, store.id, lines, note, key);
      if (r.ok) router.push(`/stock/asks/${r.data.id}`);
      else setError(r.message);
    });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {stores.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Which store">
          {stores.map((s) => (
            <Link
              key={s.id}
              href={`/requests?tab=ask&store=${s.id}`}
              aria-current={s.id === store.id ? 'true' : undefined}
              className={`flex min-h-11 items-center rounded-full px-4 text-sm font-medium ring-1 ${
                s.id === store.id
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-white text-slate-700 ring-slate-300'
              }`}
            >
              {s.name}
            </Link>
          ))}
        </div>
      )}
      <div id="ask-lines" className="space-y-2">
        <ListSearch scope="ask-lines" count={items.length} noun="items" />
        {shortFirst(items, (i) => Number(i.par) > 0 && Number(i.on_hand) < Number(i.par)).map(
          (s) => (
            <section key={s.key} className="space-y-1" data-testid="ask-section">
              <h3
                className={`text-sm font-semibold ${s.short ? 'text-rose-700' : 'text-slate-500'}`}
              >
                {s.label}
              </h3>
              <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                {s.rows.map((i) => (
                  <li
                    key={i.item_id}
                    className="space-y-2 px-4 py-3"
                    data-filter-row
                    data-filter-text={i.name}
                  >
                    <span className="flex items-center gap-3">
                      <ItemThumb name={i.name} />
                      <span className="font-medium">{i.name}</span>
                    </span>
                    <Stepper
                      value={qty[i.item_id] ?? ''}
                      onChange={(v) => setQty((q) => ({ ...q, [i.item_id]: v }))}
                      label={`How many ${i.name}`}
                      min={0}
                      unit={i.base_uom}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">What it is for (optional)</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder={hotel ? 'Room 104' : 'Table 4'}
          className={inputClass}
        />
      </label>
      <ErrorBox message={error} />
      <button
        type="submit"
        disabled={!hydrated || pending || lines.length === 0}
        className={primaryButton}
      >
        {lines.length === 0
          ? 'Tap + on what you need'
          : `Request ${lines.length} item${lines.length === 1 ? '' : 's'}`}
      </button>
    </form>
  );
}
