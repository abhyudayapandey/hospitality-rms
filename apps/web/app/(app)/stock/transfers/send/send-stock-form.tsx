'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ListSearch } from '@/components/list-search';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { byGroup } from '@/lib/item-groups';
import { sendStock } from '../../actions';

export interface SendItem {
  item_id: string;
  name: string;
  base_uom: string;
  on_hand: string;
  item_group: string | null;
}

export function SendStockForm({
  from,
  to,
  items,
  done,
}: {
  from: string;
  to: string;
  items: SendItem[];
  done: string;
}) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [key] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const lines = items
    .map((i) => ({ item_id: i.item_id, qty: Number(qty[i.item_id]) }))
    .filter((l) => qty[l.item_id]?.trim() && l.qty > 0);

  const submit = () =>
    start(async () => {
      setError(null);
      const r = await sendStock(from, to, lines, key);
      if (r.ok) router.push(done);
      else setError(r.message);
    });

  if (items.length === 0) {
    return <p className="text-slate-600">No item is set up at both stores.</p>;
  }
  return (
    <form
      className="space-y-4"
      data-testid="send-stock"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div id="send-lines" className="space-y-2">
        <ListSearch scope="send-lines" count={items.length} noun="items" />
        {byGroup(items).map((g) => (
          <section key={g.group} className="space-y-1" data-testid={`group-${g.group}`}>
            <h2 className="text-sm font-semibold text-slate-500">{g.label}</h2>
            <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
              {g.rows.map((i) => (
                <li
                  key={i.item_id}
                  className="flex items-center justify-between gap-3 px-4 py-2"
                  data-filter-row
                  data-filter-text={i.name}
                >
                  <label htmlFor={`s-${i.item_id}`} className="min-w-0 flex-1 text-sm">
                    <span className="block font-medium">{i.name}</span>
                    <span className="text-xs text-slate-500">
                      in stock here: {Number(i.on_hand)} {i.base_uom}
                    </span>
                  </label>
                  <input
                    id={`s-${i.item_id}`}
                    aria-label={`Send ${i.name}`}
                    inputMode="decimal"
                    value={qty[i.item_id] ?? ''}
                    onChange={(e) => setQty((v) => ({ ...v, [i.item_id]: e.target.value }))}
                    className={`${inputClass} max-w-28 text-right`}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <ErrorBox message={error} />
      <button
        type="submit"
        disabled={!hydrated || pending || lines.length === 0}
        className={primaryButton}
      >
        {lines.length === 0
          ? 'Add quantities to send'
          : `Send ${lines.length} item${lines.length === 1 ? '' : 's'}`}
      </button>
    </form>
  );
}
