import { Empty } from '@/components/messages';
import { NoReport, PeriodPicker, ReportHeader } from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import type { SearchParams } from '@/lib/params';
import {
  menuEngineering,
  reportPeriod,
  reportPlace,
  reportToday,
  type DishRow,
} from '@/lib/report-data';
import { dishClass, DISH_CLASSES } from '@/lib/reports';

// Menu engineering (R-2, ADR 028): each dish's margin against its popularity, per menu,
// sorted into stars, plowhorses, puzzles and dogs, with what to do about each group. The
// database works out the classes (rpt.menu_engineering); this page only lays them out.
export default async function MenuEngineering({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'menu_engineering', searchParams);
    if (!place) return null;
    const range = await reportPeriod(searchParams, await reportToday(tx, place.id));
    return {
      places,
      place,
      range,
      dishes: await menuEngineering(tx, place.id, range.from, range.to),
    };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, range, dishes } = data;
  const menus = [...new Set(dishes.map((d) => d.menu))];
  return (
    <div className="space-y-4">
      <ReportHeader
        report="menu_engineering"
        switcher={{ screen: 'menu_engineering', places, current: place.id }}
      />
      <PeriodPicker
        action="/reports/menu"
        node={place.id}
        period={range.period}
        from={range.from}
        to={range.to}
      />
      {menus.length === 0 && <Empty>No dishes on this menu.</Empty>}
      {menus.map((menu) => {
        const list = dishes.filter((d) => d.menu === menu);
        const first = list[0]!;
        return (
          <section key={menu} aria-label={menu} className="space-y-3" data-menu={menu}>
            <div>
              <h2 className="font-semibold">{menu === 'Bar' ? 'Drinks' : menu}</h2>
              <p className="text-xs text-slate-500">
                Average margin {formatMoney(first.avg_margin) ?? '–'} a serve · popular from{' '}
                {first.popular_from_pct ?? '–'}% of {menu === 'Bar' ? 'drinks' : 'dishes'} sold
              </p>
            </div>
            {DISH_CLASSES.map((c) => {
              const group = list.filter((d) => dishClass(d.class) === c.code);
              if (group.length === 0) return null;
              return (
                <div key={c.code} className="space-y-1" data-testid={`class-${c.code}`}>
                  <h3 className="text-sm font-semibold text-slate-700">
                    {c.title} <span className="font-normal text-slate-500">· {c.what}</span>
                  </h3>
                  <p className="text-xs text-slate-500">{c.hint}</p>
                  <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
                    {group.map((d) => (
                      <Dish key={d.code} d={d} />
                    ))}
                  </ul>
                </div>
              );
            })}
            {list.some((d) => dishClass(d.class) === null) && (
              <p className="text-xs text-slate-500">
                Not placed (nothing sold on this menu, or no recipe):{' '}
                {list
                  .filter((d) => dishClass(d.class) === null)
                  .map((d) => d.name)
                  .join(', ')}
              </p>
            )}
          </section>
        );
      })}
      <p className="text-xs text-slate-500">
        {formatDay(range.from)} to {formatDay(range.to)}. Margin is the price before tax less the
        recipe cost, ingredients at their average cost. Popular: at least 70% of an equal share of
        what sold. High margin: at least the menu&apos;s average, weighted by what sold.
      </p>
    </div>
  );
}

function Dish({ d }: { d: DishRow }) {
  return (
    <li
      className="flex justify-between gap-2 px-4 py-3 text-sm"
      data-testid="dish"
      data-code={d.code}
    >
      <span className="min-w-0">
        <span className="block font-medium">{d.name}</span>
        <span className="block text-xs text-slate-500">
          {Number(d.sold)} sold · {d.mix_pct ?? '0'}% of the menu
        </span>
      </span>
      <span className="shrink-0 text-right tabular-nums">
        {formatMoney(d.margin) ?? '–'}
        <span className="block text-xs text-slate-500">
          {formatMoney(d.price)} less {formatMoney(d.cost) ?? '–'}
        </span>
      </span>
    </li>
  );
}
