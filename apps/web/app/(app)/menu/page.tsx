import Link from 'next/link';
import { Empty } from '@/components/messages';
import { PlaceSwitcher } from '@/components/place-switcher';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { param, type SearchParams } from '@/lib/inventory';
import { highCost, myRecipes, outletCosting } from '@/lib/menu';
import { placesFor } from '@/lib/places';
import { salesPlaces } from '@/lib/production';
import { MenuTabs, RecipeList } from './parts';

// Menu costs (ADR 014): cost per serve and cost % of each menu item at an outlet, at the
// current weighted-average cost (standard where there is no stock yet). Only the stores
// where the person holds MENU view are listed; without any, the recipes they may read.
// People covering several outlets pick one with the "Place:" switcher (ADR 016).
export default async function MenuPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const ctx = await placesFor('menu', searchParams);
  // recipe pages link back with ?outlet=
  // without Menu and sales (ADR 026) the screen is the recipes, as for people without costs
  const place = ctx.shell.modules.has('menu_sales')
    ? (ctx.places.find((p) => p.id === param(sp, 'outlet')) ?? ctx.place)
    : null;
  const data = await withUser(ctx.shell.user.id, async (tx) => {
    if (!place) return { recipes: await myRecipes(tx), rows: [], outlet: null };
    const recipes = await myRecipes(tx);
    return {
      recipes,
      rows: await outletCosting(tx, place.id),
      outlet: { outlet_id: place.id, outlet_name: place.name },
      sales: await salesPlaces(tx),
    };
  });

  if (!data.outlet) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Recipes</h1>
        <RecipeList recipes={data.recipes} />
      </div>
    );
  }
  const recipeOf = new Map(
    data.recipes.filter((r) => r.kind === 'menu').map((r) => [r.subject_id, r]),
  );
  const groups = [...new Set(data.rows.map((r) => `${r.menu} · ${r.category}`))];
  return (
    <div className="space-y-4">
      <PlaceSwitcher screen="menu" places={ctx.places} current={data.outlet.outlet_id} quiet />
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Menu costs</h1>
        <p className="truncate text-sm text-slate-600" data-testid="menu-outlet">
          {data.outlet.outlet_name}
        </p>
      </div>
      <MenuTabs active="costs" costs sales={data.sales.length > 0} />
      <p className="text-xs text-slate-500">
        Cost per serve at today&apos;s average stock cost (standard cost where there is no stock);
        prices before tax.
      </p>
      {data.rows.length === 0 ? (
        <Empty>No menu items are sold here yet.</Empty>
      ) : (
        groups.map((g) => (
          <section key={g} className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-500">{g}</h2>
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
              {data.rows
                .filter((r) => `${r.menu} · ${r.category}` === g)
                .map((r) => {
                  const recipe = recipeOf.get(r.menu_item_id);
                  const high = highCost(r.menu, r.cost_pct);
                  return (
                    <li key={r.menu_item_id} data-testid="menu-row" data-code={r.code}>
                      <Link
                        href={
                          recipe
                            ? `/menu/recipes/${recipe.recipe_id}?store=${r.store_id}&outlet=${data.outlet.outlet_id}`
                            : '#'
                        }
                        className="flex min-h-14 items-center justify-between gap-3 px-4 py-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{r.name}</span>
                          <span className="text-xs text-slate-500">
                            {formatMoney(r.price, r.currency)} · cost{' '}
                            <span data-testid="cost-per-serve">
                              {formatMoney(r.cost_per_serve, r.currency)}
                            </span>
                          </span>
                        </span>
                        <span
                          data-testid="cost-pct"
                          className={`shrink-0 rounded-full px-2 py-0.5 text-sm font-semibold tabular-nums ${
                            high ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-800'
                          }`}
                        >
                          {r.cost_pct === null ? '–' : `${Number(r.cost_pct).toFixed(1)}%`}
                        </span>
                      </Link>
                    </li>
                  );
                })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
