'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ListSearch } from '@/components/list-search';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import type { ItemOption } from '@/lib/inventory';
import { UnusualNote } from '@/components/unusual-note';
import { byGroup } from '@/lib/item-groups';
import { requestTransfer } from '../../actions';
import { formatQty } from '@/lib/qty';

export function TransferRequestForm({
  to,
  from: initialFrom,
  sources,
  items,
}: {
  to: string;
  /** the source the items were listed for; another source lists its own (ADR 051) */
  from: string | null;
  sources: { id: string; name: string }[];
  items: ItemOption[];
}) {
  const router = useRouter();
  const [from, setFrom] = useState(initialFrom ?? sources[0]?.id ?? '');
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
      const r = await requestTransfer(from, to, lines, key);
      if (r.ok) router.push(`/stock/transfers/${r.data.id}?node=${to}`);
      else setError(r.message);
    });

  if (sources.length === 0)
    return <p className="text-slate-600">There is nowhere to request from.</p>;
  const fromName = sources.find((s) => s.id === from)?.name ?? '';
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
        <select
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            router.replace(`/stock/transfers/new?node=${to}&from=${e.target.value}`);
          }}
          className={inputClass}
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div id="transfer-lines" className="space-y-2">
        {items.length === 0 && (
          <p className="text-sm text-slate-600" data-testid="nothing-to-ask">
            {fromName} keeps nothing this store uses.
          </p>
        )}
        <ListSearch scope="transfer-lines" count={items.length} noun="items" />
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
                  <label htmlFor={`t-${i.item_id}`} className="min-w-0 flex-1 text-sm">
                    <span className="block font-medium">{i.name}</span>
                    <span className="text-xs text-slate-500">
                      here: {formatQty(i.on_hand, i.base_uom)}
                      {i.par_level && Number(i.par_level) > 0
                        ? ` · par ${formatQty(i.par_level, i.base_uom)}`
                        : ''}
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
          </section>
        ))}
      </div>
      <UnusualNote node={to} kind="transfer" lines={lines} />
      <ErrorBox message={error} />
      <button
        type="submit"
        disabled={!hydrated || pending || lines.length === 0}
        className={primaryButton}
      >
        {lines.length === 0
          ? 'Add quantities to request'
          : `Request ${lines.length} item${lines.length === 1 ? '' : 's'}`}
      </button>
    </form>
  );
}
