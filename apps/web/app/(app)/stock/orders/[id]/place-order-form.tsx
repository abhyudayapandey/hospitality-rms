'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { placeOrder, type OrderGroup } from '../../actions';
import { formatQty } from '@/lib/qty';
import { ItemThumb } from '@/components/item-thumb';
import { DateInput } from '@/components/date-time-inputs';
import { Stepper } from '@/components/stepper';
import { qtyStep } from '@/lib/short-first';
import { callAction } from '@/lib/call-action';

export interface PlaceLine {
  item_id: string;
  name: string;
  base_uom: string;
  qty: string;
  preferred_supplier_id: string | null;
}

const NONE = '';
/** A day from today on this phone's calendar (the outlet's), not UTC's (ADR 053): before
 * 05:30 in India, UTC's "tomorrow" is still today. */
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * The order desk places a supply request (ADR 049). Most requests go to one supplier, so that
 * is the default: one supplier (optional) and one date for everything. When the items'
 * usual suppliers differ the form opens with a supplier per item; the items with the same
 * supplier become one order each, each with its own date. Each line's quantity starts at what
 * was asked (what is short) and may be changed: up when no one had to approve it, never above
 * what someone approved (ADR 163). While the order waits for its approval the form shows, greyed
 * out, with why.
 */
export function PlaceOrderForm({
  po,
  lines,
  suppliers,
  waiting = null,
  capped = false,
}: {
  po: string;
  lines: PlaceLine[];
  suppliers: { id: string; name: string }[];
  /** why it cannot be placed yet ("Waiting for Rhea to approve"); the form shows, greyed out */
  waiting?: string | null;
  /** someone approved these quantities: they may go down, not up */
  capped?: boolean;
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
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.item_id, String(Number(l.qty))])),
  );
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
      for (const l of lines) {
        const n = Number(qty[l.item_id]);
        if (!(n > 0)) return setError(`Enter how much ${l.name} to order.`);
        if (capped && n > Number(l.qty)) {
          return setError(`Order no more than the ${formatQty(l.qty, l.base_uom)} approved.`);
        }
      }
      const out: OrderGroup[] = groups.map(([k, ls]) => ({
        supplier_id: k === NONE ? null : k,
        expected_on: dateOf(k),
        lines: ls.map((l) => {
          const p = price[l.item_id]?.trim();
          return {
            item_id: l.item_id,
            unit_cost: p ? Number(p) : null,
            qty: Number(qty[l.item_id]),
          };
        }),
      }));
      if (
        out.some((g) => g.lines.some((l) => l.unit_cost !== null && !(Number(l.unit_cost) >= 0)))
      ) {
        setError('Check the prices.');
        return;
      }
      const r = await callAction(placeOrder, po, out, key);
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
      {waiting && (
        <p className="text-sm text-slate-600" data-testid="place-waiting">
          {waiting}. You can place it once it is approved.
        </p>
      )}
      <fieldset disabled={!!waiting} className="space-y-4 disabled:opacity-60">
        {!several && (
          <label className="block space-y-1">
            <span className="text-sm font-medium">Supplier (optional)</span>
            {supplierSelect(one, setOne, 'Supplier')}
          </label>
        )}
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {lines.map((l) => (
            <li key={l.item_id} className="space-y-2 px-4 py-2" data-testid="place-line">
              <p className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-3">
                  <ItemThumb name={l.name} size="size-10" />
                  <span className="font-medium">{l.name}</span>
                </span>
                <span className="tabular-nums text-slate-600" data-testid="place-short">
                  {capped ? 'approved' : 'asked'} {formatQty(l.qty, l.base_uom)}
                </span>
              </p>
              <Stepper
                label={`Order ${l.name}`}
                value={qty[l.item_id] ?? ''}
                onChange={(v) => setQty((q) => ({ ...q, [l.item_id]: v }))}
                step={qtyStep(l.base_uom)}
                min={0}
                unit={l.base_uom}
              />
              {several &&
                supplierSelect(
                  per[l.item_id] ?? NONE,
                  (v) => setPer((p) => ({ ...p, [l.item_id]: v })),
                  `Supplier for ${l.name}`,
                )}
              <input
                aria-label={`Price ${l.name}`}
                inputMode="decimal"
                placeholder={`expected price per ${l.base_uom} (optional)`}
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
              <DateInput
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
          {groups.length > 1 ? `Mark ${groups.length} orders as ordered` : 'Mark as ordered'}
        </button>
      </fieldset>
    </form>
  );
}
