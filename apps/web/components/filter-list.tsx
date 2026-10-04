'use client';

import { useState, type ReactNode } from 'react';
import { pageRows, type FilterRow } from '@/lib/filter-rows';
import { inputClass } from './messages';

export interface FilterListRow extends FilterRow {
  node: ReactNode;
  /** attributes for the row's <li>, e.g. { 'data-sku': 'RICE' } for tests and styles */
  attrs?: Record<string, string>;
}

/**
 * The standard long list (UX-10): the first few rows, "Show N more", and a search box once
 * the list is longer than a screen. Rows are made on the server and passed in, so each
 * screen keeps its own look.
 *
 * Every row stays on the page and the ones not shown are only hidden. So a form keeps what
 * was typed in rows that are out of sight and submits them as before, and a test or a link
 * can still find any row.
 */
export function FilterList({
  rows,
  limit = 10,
  searchFrom = 8,
  noun = 'items',
  listClass = 'divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200',
  testid,
}: {
  rows: FilterListRow[];
  limit?: number;
  /** show the search box when there are more rows than this */
  searchFrom?: number;
  noun?: string;
  listClass?: string;
  testid?: string;
}) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const page = pageRows(rows, q, limit, all);
  const shown = new Set(page.shown.map((r) => r.key));
  return (
    <div className="space-y-2">
      {rows.length > searchFrom && (
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${noun}`}
          aria-label={`Search ${noun}`}
          enterKeyHint="search"
          className={inputClass}
          data-testid="filter-search"
        />
      )}
      <ul className={listClass} data-testid={testid}>
        {rows.map((r) => (
          <li key={r.key} hidden={!shown.has(r.key)} {...r.attrs}>
            {r.node}
          </li>
        ))}
      </ul>
      {q.trim() !== '' && page.total === 0 && (
        <p className="text-sm text-slate-600" data-testid="filter-none">
          Nothing matches “{q.trim()}”.
        </p>
      )}
      {page.more > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="min-h-11 w-full rounded-lg border border-slate-300 bg-white text-sm font-medium"
          data-testid="show-more"
        >
          Show {page.more} more
        </button>
      )}
    </div>
  );
}
