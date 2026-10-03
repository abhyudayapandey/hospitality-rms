import { Empty } from '@/components/messages';
import { PlaceSwitcher } from '@/components/place-switcher';
import { withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/inventory';
import { menuPlaces } from '@/lib/menu';
import { placesFor } from '@/lib/places';
import { addDays } from '@/lib/dates';
import { isoDate, salesSheet, todayIn } from '@/lib/production';
import { weekdayName } from '@/lib/sales-entry';
import { MenuTabs } from '../parts';
import { SalesForm } from './sales-form';

// Daily sales entry (ADR 015), until the POS import: how many of each menu item an outlet
// sold on a day. Each change depletes the store it is sold from by its recipe; sales may
// take stock below zero, which tells the store keeper instead of blocking the sale.
export default async function SalesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const today = todayIn();
  const date = isoDate(param(sp, 'date'), today);
  // the outlets where they post sales: the "Place:" switcher (ADR 016)
  const { shell, places, place } = await placesFor('sales', searchParams);
  if (!place) return <Empty>You don&apos;t post sales anywhere.</Empty>;
  // UX-4: copy yesterday's, or the same day last week's (weekends differ from weekdays)
  const yesterday = addDays(date, -1);
  const lastWeek = addDays(date, -7);
  const data = await withUser(shell.user.id, async (tx) => ({
    outlet: { outlet_id: place.id, outlet_name: place.name },
    costs: (await menuPlaces(tx)).length > 0,
    sheet: await salesSheet(tx, place.id, date),
    yesterday: await salesSheet(tx, place.id, yesterday),
    lastWeek: await salesSheet(tx, place.id, lastWeek),
  }));
  const posted = (rows: typeof data.sheet) =>
    Object.fromEntries(
      rows.filter((r) => r.posted_qty !== null).map((r) => [r.menu_item_id, Number(r.posted_qty)]),
    );
  return (
    <div className="space-y-4">
      <PlaceSwitcher screen="sales" places={places} current={place.id} quiet />
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Sales</h1>
        <p className="truncate text-sm text-slate-600" data-testid="sales-outlet">
          {data.outlet.outlet_name}
        </p>
      </div>
      <MenuTabs active="sales" costs={data.costs} sales />
      <form className="flex items-end gap-2" action="/menu/sales">
        <input type="hidden" name="node" value={data.outlet.outlet_id} />
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
        <Empty>Nothing is on this outlet&apos;s menu that day.</Empty>
      ) : (
        <SalesForm
          key={`${data.outlet.outlet_id}-${date}`}
          outlet={data.outlet.outlet_id}
          date={date}
          copies={[
            { label: 'Copy yesterday', qty: posted(data.yesterday) },
            { label: `Copy last ${weekdayName(lastWeek)}`, qty: posted(data.lastWeek) },
          ]}
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
