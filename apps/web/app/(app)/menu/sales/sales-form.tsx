'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import { copyQuantities, matchesSearch, totalSold } from '@/lib/sales-entry';
import { useHydrated } from '@/lib/use-hydrated';
import { postSales } from '../actions';
import { ItemThumb } from '@/components/item-thumb';

/** Another day's posted quantities, to copy (UX-4). */
interface Copy {
  label: string;
  qty: Record<string, number>;
}

interface Row {
  menu_item_id: string;
  code: string;
  name: string;
  group: string;
  /** already posted for this day (manual entry), or null */
  posted: number | null;
}

export function SalesForm({
  outlet,
  date,
  rows,
  copies = [],
}: {
  outlet: string;
  date: string;
  rows: Row[];
  copies?: Copy[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      rows.map((r) => [r.menu_item_id, r.posted === null ? '' : String(r.posted)]),
    ),
  );
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const shown = rows.filter((r) => matchesSearch(r, search));
  const groups = [...new Set(shown.map((r) => r.group))];
  const total = totalSold(qty);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          setDone(null);
          // send what was entered or changed; a cleared posted item becomes 0
          const lines = rows
            .filter((r) => qty[r.menu_item_id] !== '' || r.posted !== null)
            .map((r) => ({ menu_item_id: r.menu_item_id, qty: Number(qty[r.menu_item_id] || 0) }));
          if (lines.length === 0) {
            setError('Enter how many of at least one item were sold.');
            return;
          }
          if (lines.some((l) => !Number.isFinite(l.qty) || l.qty < 0)) {
            setError('Quantities are whole numbers of zero or more.');
            return;
          }
          const r = await postSales(outlet, date, lines, key);
          if (!r.ok) {
            setError(r.message);
            return;
          }
          setDone(`Sales for ${date} saved; stock is updated.`);
          setKey(crypto.randomUUID());
          router.refresh();
        });
      }}
    >
      <div className="space-y-2">
        <input
          type="search"
          aria-label="Find a dish or drink"
          placeholder="Find a dish or drink"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={inputClass}
        />
        {copies.some((c) => Object.keys(c.qty).length > 0) && (
          <div className="flex flex-wrap gap-2" data-testid="sales-copy">
            {copies
              .filter((c) => Object.keys(c.qty).length > 0)
              .map((c) => (
                <button
                  key={c.label}
                  type="button"
                  disabled={!hydrated}
                  className="min-h-11 rounded-full px-4 text-sm ring-1 ring-slate-300"
                  onClick={() => {
                    const r = copyQuantities(qty, c.qty);
                    setQty(r.qty);
                    setCopied(`${c.label.replace(/^Copy /, 'Copied ')}: ${r.changed} changed.`);
                  }}
                >
                  {c.label}
                </button>
              ))}
          </div>
        )}
        <StatusBox message={copied} />
      </div>
      {groups.length === 0 && (
        <p className="rounded-xl bg-white p-4 text-center text-sm text-slate-600 ring-1 ring-slate-200">
          Nothing on the menu matches.
        </p>
      )}
      {groups.map((g) => (
        <section key={g} className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">{g}</h2>
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {shown
              .filter((r) => r.group === g)
              .map((r) => (
                <li
                  key={r.menu_item_id}
                  className="flex items-center justify-between gap-3 px-4 py-2"
                  data-code={r.code}
                >
                  <ItemThumb name={r.name} fallback="dish" size="size-10" />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <input
                    aria-label={`Sold ${r.name}`}
                    className={`${inputClass} max-w-24 text-right`}
                    inputMode="numeric"
                    value={qty[r.menu_item_id] ?? ''}
                    onChange={(e) => setQty((q) => ({ ...q, [r.menu_item_id]: e.target.value }))}
                  />
                </li>
              ))}
          </ul>
        </section>
      ))}
      <p className="text-right text-sm text-slate-600" data-testid="sales-total">
        {total} sold in all
      </p>
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button className={primaryButton} disabled={!hydrated || pending}>
        {pending ? 'Saving…' : "Save the day's sales"}
      </button>
    </form>
  );
}
