import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { formatQty, isUuid, param, type SearchParams } from '@/lib/inventory';
import { lineCosts, menuPlaces, myRecipes, outletCosting, procedure, recipeCard } from '@/lib/menu';
import { shelfLifeText } from '@/lib/shelf-life';
import { PriceForm } from './price-form';

// One recipe: ingredients for a batch (prep) or a serve (menu item), and a prep item's
// procedure. Costs only with ?store= where the person holds MENU view; editing only with
// MENU modify there (the database checks every store the recipe is used at).
export default async function RecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const sp = await searchParams;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const recipe = (await myRecipes(tx)).find((r) => r.recipe_id === id);
    if (!recipe) return null;
    const lines = await recipeCard(tx, id);
    const steps = recipe.kind === 'prep' ? await procedure(tx, recipe.subject_id) : [];
    const places = await menuPlaces(tx);
    const place = places.find((p) => p.store_id === param(sp, 'store'));
    const costs = place ? await lineCosts(tx, id, place.store_id) : null;
    const outlet = place && param(sp, 'outlet') === place.outlet_id ? place : null;
    const priced =
      outlet && recipe.kind === 'menu'
        ? (await outletCosting(tx, outlet.outlet_id)).find(
            (r) => r.menu_item_id === recipe.subject_id,
          )
        : undefined;
    return { recipe, lines, steps, places, place, costs, outlet, priced };
  });
  if (!data) {
    return <Empty>You can&apos;t open this recipe.</Empty>;
  }
  const { recipe, lines, steps, place, costs, outlet, priced } = data;
  const cost = new Map(costs?.map((c) => [c.line_no, c]) ?? []);
  const total = costs?.reduce((s, c) => s + Number(c.line_cost ?? 0), 0) ?? null;
  const editable = place?.can_edit ?? false;
  const back = outlet ? `/menu?outlet=${outlet.outlet_id}` : '/menu/recipes';
  const storeChoices = [...new Map(data.places.map((p) => [p.store_id, p])).values()];

  return (
    <div className="space-y-4">
      <Link href={back} className="text-sm text-slate-600 underline">
        ← Back
      </Link>
      <div>
        <h1 className="text-xl font-semibold" data-testid="recipe-name">
          {recipe.name}
        </h1>
        <p className="text-sm text-slate-600">{recipe.grp}</p>
        {recipe.kind === 'prep' && (
          <p className="mt-1 text-sm" data-testid="batch">
            Batch makes <strong>{formatQty(recipe.batch_yield!, recipe.unit!)}</strong> ·{' '}
            <strong>{shelfLifeText(recipe.shelf_life_hours)}</strong>
          </p>
        )}
      </div>

      {!place && storeChoices.length > 0 && (
        <p className="text-sm">
          Costs at:{' '}
          {storeChoices.map((p, i) => (
            <span key={p.store_id}>
              {i > 0 && ', '}
              <Link className="underline" href={`/menu/recipes/${id}?store=${p.store_id}`}>
                {p.store_name}
              </Link>
            </span>
          ))}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-500">
          {recipe.kind === 'prep' ? 'Ingredients for one batch' : 'Ingredients for one serve'}
          {place && <> · costs at {place.store_name}</>}
        </h2>
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {lines.map((l) => (
            <li
              key={l.line_no}
              data-testid="recipe-line"
              className="flex justify-between gap-3 px-4 py-3"
            >
              <span className="min-w-0">
                <span className="block font-medium">{l.name}</span>
                {Number(l.trim_loss_pct) > 0 && (
                  <span className="text-xs text-slate-500">
                    {Number(l.trim_loss_pct)}% trimmed away
                  </span>
                )}
              </span>
              <span className="shrink-0 text-right tabular-nums">
                {formatQty(l.qty, l.unit)}
                {cost.has(l.line_no) && (
                  <span className="block text-xs text-slate-500" data-testid="line-cost">
                    {formatMoney(cost.get(l.line_no)!.line_cost)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
        {total !== null && (
          <p className="text-right text-sm" data-testid="recipe-total">
            {recipe.kind === 'prep' ? 'Batch cost' : 'Cost per serve'}{' '}
            <strong className="tabular-nums">{formatMoney(total)}</strong>
            {recipe.kind === 'prep' && (
              <>
                {' '}
                · {formatMoney(total / Number(recipe.batch_yield))} per {recipe.unit}
              </>
            )}
          </p>
        )}
      </section>

      {steps.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">Method</h2>
          <ol className="space-y-2">
            {steps.map((s) => (
              <li
                key={s.step}
                data-testid="step"
                className="flex gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-700 text-sm font-semibold text-white">
                  {s.step}
                </span>
                <span className="min-w-0">
                  <span className="block">{s.instruction}</span>
                  {s.minutes !== null && (
                    <span className="text-xs text-slate-500">{s.minutes} min</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {editable && (
        <Link
          href={`/menu/recipes/${id}/edit?store=${place!.store_id}${outlet ? `&outlet=${outlet.outlet_id}` : ''}`}
          className="flex min-h-12 items-center justify-center rounded-lg border border-slate-300 bg-white font-medium"
        >
          Change recipe
        </Link>
      )}
      {editable && outlet && priced && (
        <PriceForm
          menuItemId={recipe.subject_id}
          outletId={outlet.outlet_id}
          outletName={outlet.outlet_name}
          price={priced.price}
        />
      )}
    </div>
  );
}
