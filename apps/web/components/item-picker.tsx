'use client';

import { useState } from 'react';
import { Icon } from './icon';
import { ItemThumb } from './item-thumb';

/**
 * Pick one item by its picture (ADR 113): what this place uses most first, a search box above
 * for the rest. Nothing is chosen until the person taps one; the chosen item stays on top with
 * a way to change it.
 */
export function ItemPicker<T extends { item_id: string; name: string }>({
  items,
  value,
  onChange,
  often = [],
  max = 12,
  label = 'Item',
  note,
}: {
  items: readonly T[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** item ids this place uses most, first in the grid */
  often?: readonly string[];
  max?: number;
  label?: string;
  /** a short line under the name, e.g. what the store has */
  note?: ((item: T) => string | null) | undefined;
}) {
  const [q, setQ] = useState('');
  const chosen = items.find((i) => i.item_id === value) ?? null;
  if (chosen) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-brand-50 p-2 ring-1 ring-brand-200">
        <ItemThumb name={chosen.name} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold" data-testid="picked-item">
            {chosen.name}
          </span>
          {note?.(chosen) && <span className="block text-sm text-slate-600">{note(chosen)}</span>}
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="min-h-11 rounded-lg px-3 text-sm font-medium ring-1 ring-slate-300"
        >
          Change
        </button>
      </div>
    );
  }
  const rank = (id: string) => {
    const n = often.indexOf(id);
    return n < 0 ? often.length : n;
  };
  const words = q.trim().toLowerCase();
  const shown = items
    .filter((i) => !words || i.name.toLowerCase().includes(words))
    .map((i, n) => ({ i, n }))
    .sort((a, b) => rank(a.i.item_id) - rank(b.i.item_id) || a.n - b.n)
    .map((x) => x.i);
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <label className="flex min-h-12 items-center gap-2 rounded-xl bg-white px-3 ring-1 ring-slate-300">
        <Icon name="search" className="size-5 shrink-0 text-slate-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find an item"
          aria-label="Find an item"
          className="min-w-0 flex-1 bg-transparent py-2 outline-none"
        />
      </label>
      <ul className="grid grid-cols-3 gap-2">
        {shown.slice(0, max).map((i) => (
          <li key={i.item_id}>
            <button
              type="button"
              onClick={() => onChange(i.item_id)}
              aria-label={i.name}
              data-testid="item-choice"
              className="flex min-h-26 w-full flex-col items-center justify-start gap-1 rounded-xl bg-white p-2 text-center ring-1 ring-slate-200"
            >
              <ItemThumb name={i.name} />
              <span className="line-clamp-2 text-xs leading-tight font-medium">{i.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {shown.length > max && (
        <p className="text-sm text-slate-500">
          {shown.length - max} more: type a few letters to find them.
        </p>
      )}
      {shown.length === 0 && <p className="text-sm text-slate-500">Nothing here by that name.</p>}
    </div>
  );
}
