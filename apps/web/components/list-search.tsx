'use client';

import { useId } from 'react';
import { matchRows } from '@/lib/filter-rows';
import { inputClass } from './messages';

/**
 * A search box for a long list that is already on the page (UX-10): the stock hub and the
 * forms that list every item. It hides the rows (`data-filter-row`, with `data-filter-text`)
 * of the container it sits in that do not match, and a group (`data-filter-group`) with none
 * left. Hiding, not removing, so a form keeps what was typed in rows out of sight and sends
 * it as before. Shown only when there are more than `from` rows.
 */
export function ListSearch({
  scope,
  noun = 'items',
  from = 8,
  count,
}: {
  /** the id of the element that holds the rows */
  scope: string;
  noun?: string;
  from?: number;
  /** how many rows there are, to know whether a box is worth showing */
  count: number;
}) {
  const id = useId();
  if (count <= from) return null;
  const apply = (q: string) => {
    const root = document.getElementById(scope);
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>('[data-filter-row]')) {
      const text = el.dataset.filterText ?? el.textContent ?? '';
      el.hidden = matchRows([{ key: '', text }], q).length === 0;
    }
    for (const g of root.querySelectorAll<HTMLElement>('[data-filter-group]')) {
      g.hidden = g.querySelectorAll('[data-filter-row]:not([hidden])').length === 0;
    }
  };
  return (
    <input
      id={id}
      type="search"
      placeholder={`Search ${noun}`}
      aria-label={`Search ${noun}`}
      enterKeyHint="search"
      onChange={(e) => apply(e.target.value)}
      className={inputClass}
      data-testid="list-search"
    />
  );
}
