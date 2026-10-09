'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import type { IngredientOption, RecipeRow } from '@/lib/menu';
import { useHydrated } from '@/lib/use-hydrated';
import { saveRecipe } from '../../../actions';
import { ItemThumb } from '@/components/item-thumb';

interface Line {
  ingredient_item_id: string;
  qty: string;
  trim_loss_pct: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export function RecipeEditor({
  recipe,
  lines: initial,
  options,
  back,
}: {
  recipe: RecipeRow;
  lines: Line[];
  options: IngredientOption[];
  back: string;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [lines, setLines] = useState<Line[]>(initial);
  const [from, setFrom] = useState(today);
  const [batch, setBatch] = useState(recipe.batch_yield ? String(Number(recipe.batch_yield)) : '');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const unitOf = (id: string) => options.find((o) => o.item_id === id)?.unit ?? '';
  const update = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const clean = lines.map((l) => ({
            ingredient_item_id: l.ingredient_item_id,
            qty: Number(l.qty),
            unit: unitOf(l.ingredient_item_id),
            trim_loss_pct: Number(l.trim_loss_pct || 0),
          }));
          if (clean.some((l) => !l.ingredient_item_id || !(l.qty > 0))) {
            setError('Each line needs an ingredient and a quantity above zero.');
            return;
          }
          const r = await saveRecipe(
            recipe.kind,
            recipe.subject_id,
            clean,
            from,
            recipe.kind === 'prep' ? Number(batch) : null,
          );
          if (!r.ok) {
            setError(r.message);
            return;
          }
          // a version from a later date is not in force yet: back to the current one
          router.push(from === today() ? back.replace(recipe.recipe_id, r.data.id) : back);
          router.refresh();
        });
      }}
    >
      <ul className="space-y-3">
        {lines.map((l, i) => (
          <li
            key={i}
            data-testid="edit-line"
            className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200"
          >
            <span className="flex items-center gap-3">
              {l.ingredient_item_id && (
                <ItemThumb name={options.find((o) => o.item_id === l.ingredient_item_id)?.name} />
              )}
              <select
                aria-label={`Ingredient ${i + 1}`}
                className={inputClass}
                value={l.ingredient_item_id}
                onChange={(e) => update(i, { ingredient_item_id: e.target.value })}
              >
                <option value="">Choose…</option>
                {options.map((o) => (
                  <option key={o.item_id} value={o.item_id}>
                    {o.name} ({o.unit}){o.kind === 'prep' ? ' · prep' : ''}
                  </option>
                ))}
              </select>
            </span>
            <div className="flex gap-2">
              <label className="flex-1 space-y-1">
                <span className="text-xs">Quantity ({unitOf(l.ingredient_item_id) || 'unit'})</span>
                <input
                  aria-label={`Quantity ${i + 1}`}
                  className={inputClass}
                  inputMode="decimal"
                  value={l.qty}
                  onChange={(e) => update(i, { qty: e.target.value })}
                />
              </label>
              <label className="w-24 space-y-1">
                <span className="text-xs">Trim %</span>
                <input
                  aria-label={`Trim ${i + 1}`}
                  className={inputClass}
                  inputMode="decimal"
                  value={l.trim_loss_pct}
                  onChange={(e) => update(i, { trim_loss_pct: e.target.value })}
                />
              </label>
            </div>
            <button
              type="button"
              className="text-sm text-rose-700 underline"
              onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
            >
              Remove line
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={secondaryButton}
        onClick={() =>
          setLines((ls) => [...ls, { ingredient_item_id: '', qty: '', trim_loss_pct: '0' }])
        }
      >
        Add an ingredient
      </button>
      {recipe.kind === 'prep' && (
        <label className="block space-y-1">
          <span className="text-sm">One batch makes ({recipe.unit})</span>
          <input
            className={inputClass}
            inputMode="decimal"
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
          />
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-sm">In use from</span>
        <input
          className={inputClass}
          type="date"
          min={today()}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <ErrorBox message={error} />
      <button className={primaryButton} disabled={!hydrated || pending}>
        {pending ? 'Saving…' : 'Save new version'}
      </button>
      <Link href={back} className="block text-center text-sm text-slate-600 underline">
        Cancel
      </Link>
    </form>
  );
}
