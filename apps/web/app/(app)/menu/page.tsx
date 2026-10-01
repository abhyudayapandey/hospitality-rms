import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { param, type SearchParams } from '@/lib/inventory';
import { highCost, menuPlaces, myRecipes, outletCosting } from '@/lib/menu';
import { salesPlaces } from '@/lib/production';
import { MenuTabs, RecipeList } from './parts';

// Menu costs (ADR 014): cost per serve and cost % of each menu item at an outlet, at the
// current weighted-average cost (standard where there is no stock yet). Only the stores
// where the person holds MENU view are listed; without any, the recipes they may read.
export default async function MenuPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const data = await withUser(user.id, async (tx) => {
    const places = await menuPlaces(tx);
    if (places.length === 0)
      return { places, recipes: await myRecipes(tx), rows: [], outlet: null };
    const outlet = places.find((p) => p.outlet_id === param(sp, 'outlet')) ?? places[0]!;
    const recipes = await myRecipes(tx);
    return {
      places,
      recipes,
      rows: await outletCosting(tx, outlet.outlet_id),
      outlet,
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
  const outlets = [...new Map(data.places.map((p) => [p.outlet_id, p.outlet_name]))];
  const recipeOf = new Map(
    data.recipes.filter((r) => r.kind === 'menu').map((r) => [r.subject_id, r]),
  );
  const groups = [...new Set(data.rows.map((r) => `${r.menu} · ${r.category}`))];
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Menu costs</h1>
        <p className="truncate text-sm text-slate-600" data-testid="menu-outlet">
          {data.outlet.outlet_name}
        </p>
      </div>
      <MenuTabs active="costs" costs sales={data.sales.length > 0} />
      {outlets.length > 1 && (
        <nav aria-label="Outlet" className="-mx-4 overflow-x-auto px-4">
          <ul className="flex gap-2">
            {outlets.map(([id, name]) => (
              <li key={id}>
                <Link
                  href={`/menu?outlet=${id}`}
                  aria-current={id === data.outlet.outlet_id ? 'true' : undefined}
                  className={`flex min-h-11 items-center rounded-full px-4 text-sm whitespace-nowrap ${
                    id === data.outlet.outlet_id
                      ? 'bg-slate-200 font-semibold'
                      : 'ring-1 ring-slate-300'
                  }`}
                >
                  {name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <p className="text-xs text-slate-500">
        Cost per serve at today&rsquo;s average stock cost (standard cost where there is no stock);
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
