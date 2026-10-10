'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { ItemThumb } from '@/components/item-thumb';
import { formatQty } from '@/lib/qty';
import { useHydrated } from '@/lib/use-hydrated';
import { countRoom } from '../actions';

export interface CountLine {
  item_id: string;
  item: string;
  unit: string;
  expected: string;
}

/** Count a room (ADR 094): what is there of each thing it should hold; nothing filled in. */
export function RoomCountForm({
  room,
  back,
  lines,
}: {
  room: string;
  back: string;
  lines: CountLine[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    start(async () => {
      setError(null);
      const missing = lines.filter((l) => (counts[l.item_id] ?? '').trim() === '');
      if (missing.length) return setError(`Count ${missing.map((l) => l.item).join(', ')}.`);
      const r = await countRoom(
        room,
        lines.map((l) => ({ item_id: l.item_id, counted: Number(counts[l.item_id]) })),
      );
      if (!r.ok) return setError(r.message);
      router.push(back);
    });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {lines.map((l) => (
          <li key={l.item_id} className="flex items-center gap-3 px-4 py-2">
            <ItemThumb name={l.item} size="size-10" />
            <label className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{l.item}</span>
                <span className="block text-xs text-slate-500">
                  should have {formatQty(l.expected, l.unit)}
                </span>
              </span>
              <input
                inputMode="decimal"
                aria-label={l.item}
                value={counts[l.item_id] ?? ''}
                onChange={(e) => setCounts({ ...counts, [l.item_id]: e.target.value })}
                className={`${inputClass} w-20 text-right`}
              />
            </label>
          </li>
        ))}
      </ul>
      <ErrorBox message={error} />
      <button type="submit" disabled={!hydrated || pending} className={primaryButton}>
        Save the count
      </button>
    </form>
  );
}
