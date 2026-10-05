'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { ListSearch } from '@/components/list-search';
import { UnusualNote } from '@/components/unusual-note';
import { requestSupplies } from '../../actions';

export interface OrderLine {
  item_id: string;
  name: string;
  base_uom: string;
  on_hand: string;
  par_level: string;
  suggested_qty: string;
}

const trim = (n: string) => String(Number(n));

export function NewOrderForm({ node, lines }: { node: string; lines: OrderLine[] }) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      lines.map((l) => [l.item_id, Number(l.suggested_qty) > 0 ? trim(l.suggested_qty) : '']),
    ),
  );
  const [notes, setNotes] = useState('');
  const [usual, setUsual] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);

  const chosen = lines
    .map((l) => ({ item_id: l.item_id, qty: Number(qty[l.item_id]) }))
    .filter((l) => qty[l.item_id]?.trim() && l.qty > 0);

  const submit = () =>
    start(async () => {
      setError(null);
      if (chosen.some((l) => !Number.isFinite(l.qty))) {
        setError('Check the quantities.');
        return;
      }
      const r = await requestSupplies(node, chosen, notes, key);
      if (r.ok) router.push(`/stock/orders/${r.data.id}?node=${node}`);
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
      <div id="order-lines" className="space-y-2">
        <ListSearch scope="order-lines" count={lines.length} noun="items" />
        {lines.some((l) => Number(l.suggested_qty) > 0) && lines.length > 8 && (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={usual}
              onChange={(e) => {
                setUsual(e.target.checked);
                for (const el of document.querySelectorAll<HTMLElement>(
                  '#order-lines [data-usual="no"]',
                )) {
                  el.hidden = e.target.checked;
                }
              }}
              className="size-5"
            />
            Only items that are running short
          </label>
        )}
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {lines.map((l) => (
            <li
              key={l.item_id}
              className="space-y-1 px-4 py-2"
              data-testid="order-line"
              data-filter-row
              data-filter-text={l.name}
              data-usual={Number(l.suggested_qty) > 0 ? 'yes' : 'no'}
            >
              <p className="flex justify-between gap-2 text-sm">
                <span className="font-medium">{l.name}</span>
                <span className="text-slate-500 tabular-nums">
                  {trim(l.on_hand)} / {trim(l.par_level)} {l.base_uom}
                </span>
              </p>
              <input
                aria-label={`Quantity ${l.name}`}
                inputMode="decimal"
                placeholder={`how much (${l.base_uom})`}
                value={qty[l.item_id] ?? ''}
                onChange={(e) => setQty((v) => ({ ...v, [l.item_id]: e.target.value }))}
                className={inputClass}
              />
            </li>
          ))}
        </ul>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Notes (optional)</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
      </label>
      <UnusualNote
        node={node}
        kind="order"
        lines={chosen.map((l) => ({ item_id: l.item_id, qty: l.qty }))}
      />
      <ErrorBox message={error} />
      <button
        type="submit"
        disabled={!hydrated || pending || chosen.length === 0}
        className={primaryButton}
      >
        Send request · {chosen.length} {chosen.length === 1 ? 'item' : 'items'}
      </button>
    </form>
  );
}
