'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ListSearch } from '@/components/list-search';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { byGroup } from '@/lib/item-groups';
import { toKeepLevel } from '@/lib/send-keep';
import { FillToPar } from '@/components/fill-to-par';
import { formatQty, inputQty } from '@/lib/qty';
import { sendStock } from '../../actions';

export interface SendItem {
  item_id: string;
  name: string;
  base_uom: string;
  on_hand: string;
  item_group: string | null;
  /** what the department has and its par (ADR 053) */
  to_on_hand: string;
  to_keep: string;
}

export function SendStockForm({
  from,
  to,
  toName,
  items,
  done,
}: {
  from: string;
  to: string;
  /** the department's short name: "Kitchen Store: 2 kg · par 10 kg" */
  toName: string;
  items: SendItem[];
  done: string;
}) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [key] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [filled, setFilled] = useState(false);
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

  const short = items.filter((i) => toKeepLevel(i) > 0);
  if (items.length === 0) {
    return <p className="text-slate-600">There is nothing in stock here to send.</p>;
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
        <FillToPar
          short={short.length}
          filled={filled}
          onFill={() => {
            setQty((v) => ({
              ...v,
              ...Object.fromEntries(short.map((i) => [i.item_id, inputQty(toKeepLevel(i))])),
            }));
            setFilled(true);
          }}
          onClear={() => {
            setQty((v) =>
              Object.fromEntries(
                Object.entries(v).filter(([id]) => !short.some((i) => i.item_id === id)),
              ),
            );
            setFilled(false);
          }}
        />
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
                    <span className="block font-medium" data-testid="item-name">
                      {i.name}
                    </span>
                    <span className="block text-xs text-slate-500">
                      In stock here {formatQty(i.on_hand, i.base_uom)}
                    </span>
                    <span
                      className={`block text-xs ${toKeepLevel(i) > 0 ? 'font-medium text-rose-700' : 'text-slate-500'}`}
                      data-testid="their-stock"
                    >
                      {toName} {formatQty(i.to_on_hand, i.base_uom)}
                      {Number(i.to_keep) > 0 ? ` · par ${formatQty(i.to_keep, i.base_uom)}` : ''}
                      {Number(i.to_on_hand) < 0 ? ' (below zero: count it)' : ''}
                    </span>
                  </label>
                  <input
                    id={`s-${i.item_id}`}
                    aria-label={`Send ${i.name}`}
                    inputMode="decimal"
                    value={qty[i.item_id] ?? ''}
                    onChange={(e) => setQty((v) => ({ ...v, [i.item_id]: e.target.value }))}
                    onBlur={(e) =>
                      e.target.value.trim() &&
                      setQty((v) => ({
                        ...v,
                        [i.item_id]: inputQty(e.target.value) || e.target.value,
                      }))
                    }
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
