import Link from 'next/link';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/inventory';
import { menuPlaces } from '@/lib/menu';
import { isoDate, salesPlaces, salesSheet, todayIn } from '@/lib/production';
import { MenuTabs } from '../parts';
import { SalesForm } from './sales-form';

// Daily sales entry (ADR 015), until the POS import: how many of each menu item an outlet
// sold on a day. Each change depletes the store it is sold from by its recipe; sales may
// take stock below zero, which tells the store keeper instead of blocking the sale.
export default async function SalesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const user = await requireUser();
  const today = todayIn();
  const date = isoDate(param(sp, 'date'), today);
  const data = await withUser(user.id, async (tx) => {
    const places = await salesPlaces(tx);
    const outlet = places.find((p) => p.outlet_id === param(sp, 'outlet')) ?? places[0];
    return {
      places,
      outlet,
      costs: (await menuPlaces(tx)).length > 0,
      sheet: outlet ? await salesSheet(tx, outlet.outlet_id, date) : [],
    };
  });
  if (!data.outlet) return <Empty>You don&rsquo;t post sales anywhere.</Empty>;
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Sales</h1>
        <p className="truncate text-sm text-slate-600" data-testid="sales-outlet">
          {data.outlet.outlet_name}
        </p>
      </div>
      <MenuTabs active="sales" costs={data.costs} sales />
      {data.places.length > 1 && (
        <nav aria-label="Outlet" className="-mx-4 overflow-x-auto px-4">
          <ul className="flex gap-2">
            {data.places.map((p) => (
              <li key={p.outlet_id}>
                <Link
                  href={`/menu/sales?outlet=${p.outlet_id}&date=${date}`}
                  aria-current={p.outlet_id === data.outlet!.outlet_id ? 'true' : undefined}
                  className={`flex min-h-11 items-center rounded-full px-4 text-sm whitespace-nowrap ${
                    p.outlet_id === data.outlet!.outlet_id
                      ? 'bg-slate-200 font-semibold'
                      : 'ring-1 ring-slate-300'
                  }`}
                >
                  {p.outlet_name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <form className="flex items-end gap-2" action="/menu/sales">
        <input type="hidden" name="outlet" value={data.outlet.outlet_id} />
        <label className="flex-1 space-y-1">
          <span className="text-sm">Day</span>
          <input
            type="date"
            name="date"
            max={today}
            defaultValue={date}
            className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
          />
        </label>
        <button className="min-h-12 rounded-lg border border-slate-300 bg-white px-4">Show</button>
      </form>
      {data.sheet.length === 0 ? (
        <Empty>Nothing is on this outlet&rsquo;s menu that day.</Empty>
      ) : (
        <SalesForm
          key={`${data.outlet.outlet_id}-${date}`}
          outlet={data.outlet.outlet_id}
          date={date}
          rows={data.sheet.map((r) => ({
            menu_item_id: r.menu_item_id,
            code: r.code,
            name: r.name,
            group: `${r.menu} · ${r.category}`,
            posted: r.posted_qty === null ? null : Number(r.posted_qty),
          }))}
        />
      )}
    </div>
  );
}
