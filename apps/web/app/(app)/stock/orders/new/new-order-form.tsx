'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { formatMoney } from '@/lib/format';
import { createPo } from '../../actions';

export interface OrderLine {
  item_id: string;
  name: string;
  base_uom: string;
  on_hand: string;
  par_level: string;
  suggested_qty: string;
  unit_cost: string;
  preferred_supplier_id: string | null;
}

const trim = (n: string) => String(Number(n));

export function NewOrderForm({
  node,
  lines,
  suppliers,
}: {
  node: string;
  lines: OrderLine[];
  suppliers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const suggestedSupplier = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of lines) {
      if (Number(l.suggested_qty) > 0 && l.preferred_supplier_id) {
        counts.set(l.preferred_supplier_id, (counts.get(l.preferred_supplier_id) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? suppliers[0]?.id ?? '';
  }, [lines, suppliers]);
  const [supplier, setSupplier] = useState(suggestedSupplier);
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      lines.map((l) => [
        l.item_id,
        Number(l.suggested_qty) > 0 && l.preferred_supplier_id === suggestedSupplier
          ? trim(l.suggested_qty)
          : '',
      ]),
    ),
  );
  const [cost, setCost] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.item_id, trim(l.unit_cost)])),
  );
  const [notes, setNotes] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const chosen = lines
    .map((l) => ({
      item_id: l.item_id,
      qty: Number(qty[l.item_id]),
      unit_cost: Number(cost[l.item_id]),
    }))
    .filter((l) => qty[l.item_id]?.trim() && l.qty > 0);
  const total = chosen.reduce((s, l) => s + l.qty * l.unit_cost, 0);

  const submit = () =>
    start(async () => {
      setError(null);
      if (
        chosen.some(
          (l) => !Number.isFinite(l.qty) || !Number.isFinite(l.unit_cost) || l.unit_cost < 0,
        )
      ) {
        setError('Check the quantities and prices.');
        return;
      }
      const r = await createPo(node, supplier, chosen, notes, key);
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
      <label className="block space-y-1">
        <span className="text-sm font-medium">Supplier</span>
        <select
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          className={inputClass}
        >
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {lines.map((l) => (
          <li key={l.item_id} className="space-y-1 px-4 py-2" data-testid="order-line">
            <p className="flex justify-between gap-2 text-sm">
              <span className="font-medium">{l.name}</span>
              <span className="text-slate-500 tabular-nums">
                {trim(l.on_hand)} / {trim(l.par_level)} {l.base_uom}
              </span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              <input
                aria-label={`Quantity ${l.name}`}
                inputMode="decimal"
                placeholder={`qty (${l.base_uom})`}
                value={qty[l.item_id] ?? ''}
                onChange={(e) => setQty((v) => ({ ...v, [l.item_id]: e.target.value }))}
                className={inputClass}
              />
              <input
                aria-label={`Price ${l.name}`}
                inputMode="decimal"
                placeholder="price"
                value={cost[l.item_id] ?? ''}
                onChange={(e) => setCost((v) => ({ ...v, [l.item_id]: e.target.value }))}
                className={inputClass}
              />
            </div>
          </li>
        ))}
      </ul>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Notes (optional)</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
      </label>
      <ErrorBox message={error} />
      <button type="submit" disabled={pending || chosen.length === 0} className={primaryButton}>
        Submit order · {chosen.length} lines · {formatMoney(total)}
      </button>
    </form>
  );
}
