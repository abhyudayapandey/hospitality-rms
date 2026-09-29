'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import type { ItemOption } from '@/lib/inventory';
import { requestTransfer } from '../../actions';

export function TransferRequestForm({
  to,
  sources,
  items,
}: {
  to: string;
  sources: { id: string; name: string }[];
  items: ItemOption[];
}) {
  const router = useRouter();
  const [from, setFrom] = useState(sources[0]?.id ?? '');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [key] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const lines = items
    .map((i) => ({ item_id: i.item_id, qty: Number(qty[i.item_id]) }))
    .filter((l) => qty[l.item_id]?.trim() && l.qty > 0);

  const submit = () =>
    start(async () => {
      setError(null);
      const r = await requestTransfer(from, to, lines, key);
      if (r.ok) router.push(`/stock/transfers/${r.data.id}?node=${to}`);
      else setError(r.message);
    });

  if (sources.length === 0)
    return <p className="text-slate-600">There is nowhere to request from.</p>;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="block space-y-1">
        <span className="text-sm font-medium">From</span>
        <select value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass}>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {items.map((i) => (
          <li key={i.item_id} className="flex items-center justify-between gap-3 px-4 py-2">
            <label htmlFor={`t-${i.item_id}`} className="min-w-0 flex-1 text-sm">
              <span className="block font-medium">{i.name}</span>
              <span className="text-xs text-slate-500">
                here: {Number(i.on_hand)} {i.base_uom}
              </span>
            </label>
            <input
              id={`t-${i.item_id}`}
              aria-label={`Request ${i.name}`}
              inputMode="decimal"
              value={qty[i.item_id] ?? ''}
              onChange={(e) => setQty((v) => ({ ...v, [i.item_id]: e.target.value }))}
              className={`${inputClass} max-w-28 text-right`}
            />
          </li>
        ))}
      </ul>
      <ErrorBox message={error} />
      <button type="submit" disabled={pending || lines.length === 0} className={primaryButton}>
        Request {lines.length} items
      </button>
    </form>
  );
}
