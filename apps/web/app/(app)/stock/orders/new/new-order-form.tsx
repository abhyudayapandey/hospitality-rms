'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { ListSearch } from '@/components/list-search';
import { UnusualNote } from '@/components/unusual-note';
import { FillToPar } from '@/components/fill-to-par';
import { formatQty, inputQty } from '@/lib/qty';
import { requestSupplies } from '../../actions';
import { ItemThumb } from '@/components/item-thumb';
import { Stepper } from '@/components/stepper';
import { qtyStep, shortFirst } from '@/lib/short-first';

export interface OrderLine {
  item_id: string;
  name: string;
  base_uom: string;
  on_hand: string;
  par_level: string;
  suggested_qty: string;
  category: string | null;
}

/**
 * A supply request (ADR 049): items and quantities only. Nothing is filled in (ADR 053); each
 * line says what the store has and its par, and "Fill all N short items up to par" fills what
 * would bring the short items back up to it (ADR 054).
 */
export function NewOrderForm({ node, lines }: { node: string; lines: OrderLine[] }) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>({});
  const short = lines.filter((l) => Number(l.suggested_qty) > 0);
  const [filled, setFilled] = useState(false);
  const [notes, setNotes] = useState('');
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
        <FillToPar
          short={short.length}
          filled={filled}
          onFill={() => {
            setQty((v) => ({
              ...v,
              ...Object.fromEntries(short.map((l) => [l.item_id, inputQty(l.suggested_qty)])),
            }));
            setFilled(true);
          }}
          onClear={() => {
            setQty((v) =>
              Object.fromEntries(
                Object.entries(v).filter(([id]) => !short.some((l) => l.item_id === id)),
              ),
            );
            setFilled(false);
          }}
        />
        {/* below par first, then the rest by category (ADR 101) */}
        {shortFirst(lines, (l) => Number(l.suggested_qty) > 0).map((g) => (
          <section
            key={g.key}
            className="space-y-1"
            data-filter-group
            data-testid={`order-${g.key}`}
          >
            <h2
              className={`pt-2 text-sm font-semibold ${g.short ? 'text-rose-700' : 'text-slate-500'}`}
            >
              {g.label}
            </h2>
            <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
              {g.rows.map((l) => (
                <li
                  key={l.item_id}
                  className="space-y-2 px-4 py-3"
                  data-testid="order-line"
                  data-filter-row
                  data-filter-text={`${l.name} ${l.category ?? ''}`}
                >
                  <p className="flex items-center gap-3 text-sm">
                    <ItemThumb name={l.name} category={l.category} size="size-10" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{l.name}</span>
                      <span
                        className={`block text-xs tabular-nums ${Number(l.on_hand) < 0 ? 'text-rose-700' : 'text-slate-500'}`}
                        data-testid="have-keep"
                      >
                        In stock {formatQty(l.on_hand, l.base_uom)} · par{' '}
                        {formatQty(l.par_level, l.base_uom)}
                        {Number(l.on_hand) < 0 ? ' (below zero: count it)' : ''}
                      </span>
                    </span>
                  </p>
                  <Stepper
                    label={`Quantity ${l.name}`}
                    value={qty[l.item_id] ?? ''}
                    onChange={(v) => setQty((q) => ({ ...q, [l.item_id]: v }))}
                    min={0}
                    step={qtyStep(l.base_uom)}
                    start={
                      Number(l.suggested_qty) > 0 ? Number(inputQty(l.suggested_qty)) : undefined
                    }
                    unit={l.base_uom}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
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
