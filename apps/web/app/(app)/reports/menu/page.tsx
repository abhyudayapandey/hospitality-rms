import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoReport, ReportHeader } from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { param, type SearchParams } from '@/lib/params';
import { menuEngineering, reportPlace, reportToday, type DishRow } from '@/lib/report-data';
import {
  dishClass,
  dishWords,
  DISH_CLASSES,
  MENU_MONTHS,
  menuMonths,
  monthsRange,
} from '@/lib/reports';

// Menu engineering (R-2, ADR 028): each dish's margin against its popularity, per menu,
// sorted into stars, plowhorses, puzzles and dogs, with what to do about each group. The
// database works out the classes (rpt.menu_engineering); this page only lays them out.
// It is meant for long periods: the last 3, 6, 9 or 12 months (RPT-13, ADR 033).
export default async function MenuEngineering({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'menu_engineering', searchParams);
    if (!place) return null;
    const months = menuMonths(param(await searchParams, 'months'));
    const range = monthsRange(await reportToday(tx, place.id), months);
    return {
      places,
      place,
      months,
      range,
      dishes: await menuEngineering(tx, place.id, range.from, range.to),
    };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, months, range, dishes } = data;
  const menus = [...new Set(dishes.map((d) => d.menu))];
  return (
    <div className="space-y-4">
      <ReportHeader
        report="menu_engineering"
        switcher={{ screen: 'menu_engineering', places, current: place.id }}
      />
      <nav aria-label="Period" className="grid grid-cols-4 gap-1 rounded-lg bg-slate-100 p-1">
        {MENU_MONTHS.map((m) => (
          <Link
            key={m}
            href={`/reports/menu?node=${place.id}&months=${m}`}
            aria-current={m === months ? 'page' : undefined}
            className={`flex min-h-11 items-center justify-center rounded-md text-sm ${
              m === months ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'
            }`}
          >
            {m} months
          </Link>
        ))}
      </nav>
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
                      <Dish key={d.code} d={d} menu={menu} outlet={place.id} months={months} />
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

function Dish({
  d,
  menu,
  outlet,
  months,
}: {
  d: DishRow;
  menu: string;
  outlet: string;
  months: number;
}) {
  const words = dishWords(d, menu, formatMoney);
  return (
    <li className="text-sm" data-testid="dish" data-code={d.code}>
      <Link
        href={`/reports/dish?node=${outlet}&item=${d.menu_item_id}&months=${months}`}
        className="block px-4 py-3"
      >
        <span className="block font-medium">{d.name}</span>
        <span className="block text-xs text-slate-600 tabular-nums" data-testid="dish-money">
          {words.money}
        </span>
        <span className="block text-xs text-slate-500 tabular-nums" data-testid="dish-share">
          {words.share}
        </span>
      </Link>
    </li>
  );
}
