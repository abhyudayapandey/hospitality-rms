import Link from 'next/link';
import { FilterList, type FilterListRow } from '@/components/filter-list';
import { Empty } from '@/components/messages';
import { CsvLink, NoReport, ReportHeader, ReportSections } from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { formatQty } from '@/lib/inventory';
import type { SearchParams } from '@/lib/params';
import { reportPlace, stockItems, stockSummary, type StockItemRow } from '@/lib/report-data';
import { formatMeasure, trendHref } from '@/lib/reports';
import { ItemThumb } from '@/components/item-thumb';

// Stock position (R-2, ADR 028): a store's value now and over four weeks, days on hand
// (value over average daily use) and stock that hasn't moved in 30 days. For the store's
// cost people: its store keeper, cost controller and managers (rpt.can_open). "All stores"
// (an outlet's supply point) adds up every store of the outlet they open, and expired and
// expiring stock is valued at average cost (RPT-14, ADR 033).
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
  const all = new Set(items.map((i) => i.store)).size > 1;
  const dead = items.filter((i) => i.dead);
  const dated = items
    .filter((i) => Number(i.expired_value) > 0 || Number(i.expiring_value) > 0)
    .sort(
      (a, b) =>
        Number(b.expired_value) +
        Number(b.expiring_value) -
        (Number(a.expired_value) + Number(a.expiring_value)),
    );
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
      <ReportSections
        report="stock_position"
        rows={summary}
        trend={(m) => trendHref('stock_position', place.id, m)}
      />

      {dated.length > 0 && (
        <section aria-label="Expired and expiring" className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">Expired and expiring</h2>
          <FilterList
            testid="expiry-items"
            limit={5}
            searchFrom={5}
            noun="expiring items"
            rows={dated.map((i) =>
              itemRow(
                i,
                Number(i.expired_value) > 0
                  ? `${formatMoney(i.expired_value)} expired`
                  : `${formatMoney(i.expiring_value)} expiring`,
                all,
              ),
            )}
          />
        </section>
      )}

      <section aria-label="Not moved in 30 days" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Not moved in 30 days</h2>
        {dead.length === 0 ? (
          <Empty>Everything in stock has moved in the last 30 days.</Empty>
        ) : (
          <FilterList
            testid="dead-stock"
            limit={5}
            searchFrom={5}
            noun="items"
            rows={dead.map((i) => itemRow(i, formatMoney(i.value) ?? '', all))}
          />
        )}
      </section>
      <details data-testid="stock-more">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-slate-700 underline">
          More: value by category, longest on hand
        </summary>
        <div className="space-y-4 pt-2">
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
              <FilterList
                testid="days-on-hand"
                limit={5}
                searchFrom={5}
                noun="items"
                rows={held.map((i) => itemRow(i, formatMeasure('days', i.days_on_hand), all))}
              />
            )}
          </section>
        </div>
      </details>
      <CsvLink report="stock_items" node={place.id} label="Every item as CSV" />
      <p className="text-xs text-slate-500">
        Use is stock that left for sales, production, other use, wastage and transfers, over the
        last 28 days (fewer while the store is new, at least 7). Opening stock doesn&apos;t count as
        a movement.
      </p>
    </div>
  );
}

function itemRow(i: StockItemRow, right: string, all: boolean): FilterListRow {
  return {
    key: `${i.store}:${i.sku}`,
    text: `${i.name} ${i.sku} ${i.store}`,
    attrs: { 'data-sku': i.sku, className: 'text-sm' },
    node: (
      <Link
        href={`/reports/item?node=${i.store_id}&item=${i.item_id}`}
        className="flex items-center justify-between gap-2 px-4 py-3"
      >
        <ItemThumb name={i.name} size="size-10" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{i.name}</span>
          <span className="block text-xs text-slate-500">
            {all && `${i.store} · `}
            {formatQty(i.on_hand, i.unit)} · {formatMoney(i.value)}
          </span>
        </span>
        <span className="shrink-0 text-right tabular-nums">{right}</span>
      </Link>
    ),
  };
}
