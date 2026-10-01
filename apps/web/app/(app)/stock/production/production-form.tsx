'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, StatusBox } from '@/components/messages';
import type { MadeHere } from '@/lib/production';
import { useHydrated } from '@/lib/use-hydrated';
import { recordProduction } from '../actions';

interface Line {
  ingredient_id: string;
  name: string;
  /** recipe units for one standard batch */
  qty: number;
  unit: string;
}

const round = (n: number, unit: string) =>
  unit === 'each' ? Math.round(n * 100) / 100 : Math.round(n * 10) / 10;

export function ProductionForm({
  node,
  item,
  plan,
  shelfLife,
}: {
  node: string;
  item: MadeHere;
  plan: Line[];
  /** "Use within 3 days" */
  shelfLife: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const batch = Number(item.batch_yield);
  const [made, setMade] = useState(String(batch));
  // quantities the cook changed, by ingredient; the rest follow the batch size
  const [actual, setActual] = useState<Record<string, string>>({});
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const scale = Number(made) > 0 ? Number(made) / batch : 0;

  return (
    <form
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          setDone(null);
          const qty = Number(made);
          if (!(qty > 0)) {
            setError('Enter how much the batch made.');
            return;
          }
          const lines = Object.entries(actual)
            .filter(([, v]) => v !== '')
            .map(([ingredient_item_id, v]) => ({ ingredient_item_id, qty: Number(v) }));
          if (lines.some((l) => !Number.isFinite(l.qty) || l.qty < 0)) {
            setError('Ingredient quantities are zero or more.');
            return;
          }
          const r = await recordProduction(node, item.item_id, qty, lines, key);
          if (!r.ok) {
            setError(r.message);
            return;
          }
          setDone(`Batch of ${item.name} recorded.`);
          setActual({});
          setKey(crypto.randomUUID());
          router.refresh();
        });
      }}
    >
      <h2 className="font-semibold">{item.name}</h2>
      {shelfLife && (
        <p className="text-sm text-slate-600" data-testid="shelf-life">
          {shelfLife}
        </p>
      )}
      <label className="block space-y-1">
        <span className="text-sm">
          The batch made ({item.unit}); a standard batch makes {batch}
        </span>
        <input
          aria-label="Made"
          className={inputClass}
          inputMode="decimal"
          value={made}
          onChange={(e) => setMade(e.target.value)}
        />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm text-slate-600">Used (change any that differ)</legend>
        {plan.map((l) => (
          <label key={l.ingredient_id} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm">
              {l.name} ({l.unit})
            </span>
            <input
              aria-label={`Used ${l.name}`}
              className={`${inputClass} w-28 text-right`}
              inputMode="decimal"
              value={actual[l.ingredient_id] ?? String(round(l.qty * scale, l.unit))}
              onChange={(e) => setActual((a) => ({ ...a, [l.ingredient_id]: e.target.value }))}
            />
          </label>
        ))}
      </fieldset>
      <ErrorBox message={error} />
      <StatusBox message={done} />
      <button className={primaryButton} disabled={!hydrated || pending}>
        {pending ? 'Recording…' : 'Record batch'}
      </button>
    </form>
  );
}
