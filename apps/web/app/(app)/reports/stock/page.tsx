import { Empty } from '@/components/messages';
import { NoReport, ReportHeader, ReportSections } from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { formatQty } from '@/lib/inventory';
import type { SearchParams } from '@/lib/params';
import { reportPlace, stockItems, stockSummary, type StockItemRow } from '@/lib/report-data';
import { formatMeasure } from '@/lib/reports';

// Stock position (R-2, ADR 028): a store's value now and over four weeks, days on hand
// (value over average daily use) and stock that hasn't moved in 30 days. For the store's
// cost people: its store keeper, cost controller and managers (rpt.can_open).
export default async function StockPosition({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'stock_position', searchParams);
    if (!place) return null;
    return {
      places,
      place,
      summary: await stockSummary(tx, place.id),
      items: await stockItems(tx, place.id),
    };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, summary, items } = data;
  const dead = items.filter((i) => i.dead);
  const held = items
    .filter((i) => !i.dead && i.days_on_hand !== null)
    .sort((a, b) => Number(b.days_on_hand) - Number(a.days_on_hand))
    .slice(0, 10);
  const byCategory = new Map<string, number>();
  for (const i of items)
    byCategory.set(i.category, (byCategory.get(i.category) ?? 0) + Number(i.value));
  const categories = [...byCategory].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-4">
      <ReportHeader
        report="stock_position"
        switcher={{ screen: 'stock_position', places, current: place.id }}
      />
      <ReportSections report="stock_position" rows={summary} />

      <section aria-label="Value by category" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Value by category</h2>
        {categories.length === 0 ? (
          <Empty>Nothing in stock.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {categories.map(([c, v]) => (
              <li key={c} className="flex justify-between gap-2 px-4 py-3 text-sm">
                <span>{c}</span>
                <span className="tabular-nums">{formatMeasure('money', v)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Longest on hand" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Longest on hand</h2>
        {held.length === 0 ? (
          <Empty>Not enough use yet to work out days on hand (a week at least).</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="days-on-hand"
          >
            {held.map((i) => (
              <Item key={i.sku} i={i} right={formatMeasure('days', i.days_on_hand)} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Not moved in 30 days" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Not moved in 30 days</h2>
        {dead.length === 0 ? (
          <Empty>Everything in stock has moved in the last 30 days.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="dead-stock"
          >
            {dead.map((i) => (
              <Item key={i.sku} i={i} right={formatMoney(i.value) ?? ''} />
            ))}
          </ul>
        )}
      </section>
      <p className="text-xs text-slate-500">
        Use is stock that left for sales, production, other use, wastage and transfers, over the
        last 28 days (fewer while the store is new, at least 7). Opening stock doesn&apos;t count as
        a movement.
      </p>
    </div>
  );
}

function Item({ i, right }: { i: StockItemRow; right: string }) {
  return (
    <li className="flex justify-between gap-2 px-4 py-3 text-sm" data-sku={i.sku}>
      <span className="min-w-0">
        <span className="block font-medium">{i.name}</span>
        <span className="block text-xs text-slate-500">
          {formatQty(i.on_hand, i.unit)} · {formatMoney(i.value)}
        </span>
      </span>
      <span className="shrink-0 text-right tabular-nums">{right}</span>
    </li>
  );
}
