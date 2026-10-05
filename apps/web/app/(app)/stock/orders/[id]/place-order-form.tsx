'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { placeOrder, type OrderGroup } from '../../actions';

export interface PlaceLine {
  item_id: string;
  name: string;
  base_uom: string;
  qty: string;
  preferred_supplier_id: string | null;
}

const NONE = '';
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * The order desk places a supply request (ADR 049). Most requests go to one supplier, so that
 * is the default: one supplier (optional) and one date for everything. When the items'
 * usual suppliers differ the form opens with a supplier per item; the items with the same
 * supplier become one order each, each with its own date.
 */
export function PlaceOrderForm({
  po,
  lines,
  suppliers,
}: {
  po: string;
  lines: PlaceLine[];
  suppliers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const preferred = useMemo(
    () => new Set(lines.map((l) => l.preferred_supplier_id).filter((x): x is string => !!x)),
    [lines],
  );
  const [several, setSeveral] = useState(preferred.size > 1 && lines.length > 1);
  const [one, setOne] = useState(preferred.size === 1 ? [...preferred][0]! : NONE);
  const [per, setPer] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.item_id, l.preferred_supplier_id ?? NONE])),
  );
  const [date, setDate] = useState<Record<string, string>>({});
  const [price, setPrice] = useState<Record<string, string>>({});
  const [key] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);

  // one order per supplier (items with no supplier named are one order together)
  const groups = useMemo(() => {
    const m = new Map<string, PlaceLine[]>();
    for (const l of lines) {
      const k = several ? (per[l.item_id] ?? NONE) : one;
      m.set(k, [...(m.get(k) ?? []), l]);
    }
    return [...m.entries()];
  }, [lines, several, per, one]);
  const name = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'No supplier named';
  const dateOf = (k: string) => date[k] ?? day(1);

  const submit = () =>
    start(async () => {
      setError(null);
      const out: OrderGroup[] = groups.map(([k, ls]) => ({
        supplier_id: k === NONE ? null : k,
        expected_on: dateOf(k),
        lines: ls.map((l) => {
          const p = price[l.item_id]?.trim();
          return { item_id: l.item_id, unit_cost: p ? Number(p) : null };
        }),
      }));
      if (
        out.some((g) => g.lines.some((l) => l.unit_cost !== null && !(Number(l.unit_cost) >= 0)))
      ) {
        setError('Check the prices.');
        return;
      }
      const r = await placeOrder(po, out, key);
      if (r.ok) router.refresh();
      else setError(r.message);
    });

  const supplierSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    >
      <option value={NONE}>Not decided / not listed</option>
      {suppliers.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );

  return (
    <form
      data-testid="place-order"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 className="text-sm font-semibold text-slate-500">Place the order</h2>
      {!several && (
        <label className="block space-y-1">
          <span className="text-sm font-medium">Supplier (optional)</span>
          {supplierSelect(one, setOne, 'Supplier')}
        </label>
      )}
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {lines.map((l) => (
          <li key={l.item_id} className="space-y-2 px-4 py-2" data-testid="place-line">
            <p className="flex justify-between gap-2 text-sm">
              <span className="font-medium">{l.name}</span>
              <span className="tabular-nums text-slate-600">
                {Number(l.qty)} {l.base_uom}
              </span>
            </p>
            {several &&
              supplierSelect(
                per[l.item_id] ?? NONE,
                (v) => setPer((p) => ({ ...p, [l.item_id]: v })),
                `Supplier for ${l.name}`,
              )}
            <input
              aria-label={`Price ${l.name}`}
              inputMode="decimal"
              placeholder="price per unit (optional)"
              value={price[l.item_id] ?? ''}
              onChange={(e) => setPrice((p) => ({ ...p, [l.item_id]: e.target.value }))}
              className={inputClass}
            />
          </li>
        ))}
      </ul>
      {lines.length > 1 && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={several}
            onChange={(e) => setSeveral(e.target.checked)}
            className="size-5"
          />
          Different suppliers for different items
        </label>
      )}
      <div className="space-y-2" data-testid="order-groups">
        {groups.map(([k, ls]) => (
          <label key={k || 'none'} className="block space-y-1" data-testid="order-group">
            <span className="text-sm font-medium">
              Will be delivered on
              {groups.length > 1 && (
                <span className="font-normal text-slate-500">
                  {' '}
                  · {name(k)} ({ls.length} {ls.length === 1 ? 'item' : 'items'})
                </span>
              )}
            </span>
            <input
              type="date"
              required
              min={day(0)}
              value={dateOf(k)}
              onChange={(e) => setDate((d) => ({ ...d, [k]: e.target.value }))}
              className={inputClass}
            />
          </label>
        ))}
      </div>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        {groups.length > 1 ? `Place ${groups.length} orders` : 'Ordered'}
      </button>
    </form>
  );
}
