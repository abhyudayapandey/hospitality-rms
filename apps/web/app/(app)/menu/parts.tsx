import Link from 'next/link';
import { Empty } from '@/components/messages';
import { formatQty } from '@/lib/inventory';
import type { RecipeRow } from '@/lib/menu';
import { shelfLifeText } from '@/lib/shelf-life';

// Shared pieces of the menu screens (ADR 014).

export function MenuTabs({
  active,
  costs,
  sales = false,
}: {
  active: 'costs' | 'recipes' | 'sales' | 'variance';
  costs: boolean;
  sales?: boolean;
}) {
  const tabs = [
    ...(costs ? [{ href: '/menu', label: 'Menu costs', key: 'costs' }] : []),
    { href: '/menu/recipes', label: 'Recipes', key: 'recipes' },
    ...(sales ? [{ href: '/menu/sales', label: 'Sales', key: 'sales' }] : []),
    // the Variance screen became the Cost of sales report (R-2, ADR 028)
    ...(costs ? [{ href: '/reports/cost', label: 'Cost of sales', key: 'variance' }] : []),
  ];
  // one tab is no choice (audit #8)
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Menu" className="-mx-4 flex gap-2 overflow-x-auto px-4">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? 'page' : undefined}
          className={`flex min-h-11 items-center rounded-full px-4 text-sm whitespace-nowrap ${
            t.key === active
              ? 'bg-slate-900 font-semibold text-white'
              : 'bg-white text-slate-700 ring-1 ring-slate-300'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Recipes the person may read, grouped: prep first, then the menu. No costs. */
export function RecipeList({ recipes }: { recipes: RecipeRow[] }) {
  if (recipes.length === 0) {
    return <Empty>No recipes are made or sold where you work.</Empty>;
  }
  const groups = [...new Set(recipes.map((r) => r.grp))].sort((a, b) => {
    const prep = (g: string) => (recipes.find((r) => r.grp === g)!.kind === 'prep' ? 0 : 1);
    return prep(a) - prep(b) || a.localeCompare(b);
  });
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g} className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">{g}</h2>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
            {recipes
              .filter((r) => r.grp === g)
              .map((r) => (
                <li key={r.recipe_id} data-testid="recipe-row" data-code={r.code}>
                  <Link
                    href={`/menu/recipes/${r.recipe_id}`}
                    className="flex min-h-14 items-center justify-between gap-3 px-4 py-2"
                  >
                    <span className="min-w-0 truncate font-medium">{r.name}</span>
                    {r.kind === 'prep' && (
                      <span className="shrink-0 text-right text-xs text-slate-500">
                        batch {formatQty(r.batch_yield!, r.unit!)}
                        <br />
                        {shelfLifeText(r.shelf_life_hours)}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
