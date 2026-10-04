'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { ListSearch } from '@/components/list-search';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { submitCount } from '../../actions';

export interface CountLine {
  item_id: string;
  name: string;
  category: string;
  base_uom: string;
  counted_qty: string | null;
}

export function CountForm({
  countId,
  node,
  lines,
}: {
  countId: string;
  node: string;
  lines: CountLine[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((l) => [l.item_id, l.counted_qty ?? ''])),
  );
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const counted = Object.values(values).filter((v) => v.trim() !== '').length;

  const submit = () =>
    start(async () => {
      setError(null);
      const payload = Object.entries(values)
        .filter(([, v]) => v.trim() !== '')
        .map(([item_id, v]) => ({ item_id, counted_qty: Number(v) }));
      if (payload.some((l) => !Number.isFinite(l.counted_qty) || l.counted_qty < 0)) {
        setError('Counts must be zero or more.');
        return;
      }
      const r = await submitCount(countId, payload);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setDone(
        `${r.data.posted} posted, ${r.data.approval} sent for approval, ${r.data.no_change} unchanged.`,
      );
      setTimeout(() => router.push(`/stock/count/${countId}?node=${node}`), 1200);
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div id="count-lines" className="space-y-2">
        <ListSearch scope="count-lines" count={lines.length} noun="items" />
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {lines.map((l) => (
            <li
              key={l.item_id}
              className="flex items-center justify-between gap-3 px-4 py-2"
              data-filter-row
              data-filter-text={l.name}
            >
              <label htmlFor={`c-${l.item_id}`} className="min-w-0 flex-1">
                <span className="block truncate font-medium">{l.name}</span>
                <span className="text-xs text-slate-500">{l.base_uom}</span>
              </label>
              <input
                id={`c-${l.item_id}`}
                aria-label={`Counted ${l.name}`}
                inputMode="decimal"
                value={values[l.item_id] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [l.item_id]: e.target.value }))}
                className={`${inputClass} max-w-28 text-right`}
              />
            </li>
          ))}
        </ul>
      </div>
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button
        type="submit"
        disabled={!hydrated || pending || counted === 0 || done !== null}
        className={primaryButton}
      >
        Submit count ({counted} of {lines.length} counted)
      </button>
    </form>
  );
}
