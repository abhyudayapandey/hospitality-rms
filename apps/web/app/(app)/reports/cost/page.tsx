import Link from 'next/link';
import { Empty } from '@/components/messages';
import {
  CostBreakdown,
  CsvLink,
  NoReport,
  PeriodPicker,
  ReportHeader,
  ReportSections,
} from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { companySettings } from '@/lib/settings-data';
import { formatMoney } from '@/lib/format';
import { formatQty } from '@/lib/inventory';
import type { SearchParams } from '@/lib/params';
import {
  costBreakdown,
  costExpired,
  costItems,
  costTotals,
  labourCost,
  reportPeriod,
  reportPlace,
  reportToday,
  type CostItemRow,
} from '@/lib/report-data';
import { capRange, topLosses } from '@/lib/reports';
import { LabourByDepartment } from './labour';

// Cost of sales (R-2, ADR 028; replaces the Variance screen, UX U-14): the rupees first.
// Food and drink cost against the recipes, what was lost at the count, and the five items
// that lost the most; the formula behind each item is one tap away. An outlet or site,
// at the stores the person sees the menu costs of (or all of them with REPORTS).
// Where the money went (R-3, ADR 030): each part of the cost, and people cost by
// department for those who see labour cost.
export default async function CostOfSales({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'cost_of_sales', searchParams);
    if (!place) return null;
    const range = await reportPeriod(searchParams, await reportToday(tx, place.id));
    const [totals, items, expired, parts] = await Promise.all([
      costTotals(tx, place.id, range.from, range.to),
      costItems(tx, place.id, range.from, range.to),
      costExpired(tx, place.id, range.from, range.to),
      costBreakdown(tx, place.id, range.from, range.to),
    ]);
    // the people parts come back only for those who may open labour cost here; by
    // department for up to 93 days
    const labour =
      parts.some((p) => p.part === 'labour') && capRange(range.from, range.to).from === range.from
        ? await labourCost(tx, place.id, range.from, range.to)
        : null;
    const { targets } = await companySettings(tx);
    return { places, place, range, totals, items, expired, parts, labour, targets };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, range, totals, items, expired, parts, labour, targets } = data;
  const top = topLosses(items);
  const notCounted = items.filter((i) => !i.counted);
  const stores = new Set(items.map((i) => i.store_id));
  return (
    <div className="space-y-4">
      <ReportHeader
        report="cost_of_sales"
        switcher={{ screen: 'cost_of_sales', places, current: place.id }}
      />
      <PeriodPicker
        action="/reports/cost"
        node={place.id}
        period={range.period}
        from={range.from}
        to={range.to}
      />
      <ReportSections report="cost_of_sales" rows={totals} targets={targets} />
      <CostBreakdown rows={parts} />
      {labour && <LabourByDepartment rows={labour} />}

      <section aria-label="Lost the most" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Lost the most at the count</h2>
        {top.length === 0 ? (
          <Empty>Nothing was lost at a count in this period.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="top-losses"
          >
            {top.map((r) => (
              <ItemRow key={`${r.store_id} ${r.sku}`} r={r} store={stores.size > 1} />
            ))}
          </ul>
        )}
        {notCounted.length > 0 && (
          <p className="text-sm text-slate-600" data-testid="not-counted">
            {notCounted.length} {notCounted.length === 1 ? 'item' : 'items'} not counted in this
            period, so their loss isn&apos;t known.{' '}
            <Link className="underline" href="/stock/count">
              Start a count
            </Link>
          </p>
        )}
      </section>

      {expired.length > 0 && (
        <section aria-label="Expired" className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">Expired batches thrown away</h2>
          <ul
            data-testid="expired-wastage"
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
          >
            {expired.map((e, i) => (
              <li key={i} className="flex justify-between gap-2 px-4 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">{e.name}</span>
                  <span className="block text-xs text-slate-500">
                    {e.batch_no ? `batch ${e.batch_no}` : 'no batch'}
                    {e.made_qty && ` of ${formatQty(e.made_qty, e.unit)}`}
                    {e.reported_by && ` · reported by ${e.reported_by}`}
                    {e.discarded_by && ` · thrown away by ${e.discarded_by}`}
                    {e.remade_qty && ` · remade ${formatQty(e.remade_qty, e.unit)}`}
                    {e.outcome === 'approval' && ' · waiting for approval'}
                  </span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  {formatQty(e.wasted_qty, e.unit)}
                  <span className="block text-xs text-slate-500">{formatMoney(e.value)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {items.length > 0 && (
        <details className="rounded-xl bg-white ring-1 ring-slate-200">
          <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium">
            Every item that moved ({items.length})
          </summary>
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {items.map((r) => (
              <ItemRow key={`${r.store_id} ${r.sku}`} r={r} store={stores.size > 1} />
            ))}
          </ul>
        </details>
      )}

      {items.length > 0 && (
        <CsvLink
          report="cost_items"
          node={place.id}
          period={range}
          label="Download the items as CSV"
        />
      )}
      <p className="text-xs text-slate-500">
        {formatDay(range.from)} to {formatDay(range.to)}, whole days. Cost % is cost over sales
        before tax; &ldquo;by recipe&rdquo; is what the recipes say the sales used, and the actual
        adds wastage, other use and what was lost at the count. Highlighted: a loss beyond the
        item&apos;s count tolerance.
      </p>
    </div>
  );
}

/** One item: its loss, and the stock formula behind it on a tap. */
function ItemRow({ r, store }: { r: CostItemRow; store: boolean }) {
  const qty = Number(r.variance_qty);
  return (
    <li data-testid="variance-row" data-sku={r.sku} className={r.unexplained ? 'bg-rose-50' : ''}>
      <details>
        <summary className="flex min-h-11 cursor-pointer justify-between gap-2 px-4 py-3 text-sm">
          <span className="min-w-0">
            <span className="block font-medium">{r.name}</span>
            {store && (
              <span className="block truncate text-xs text-slate-500">
                {r.store_name.split(' – ').pop()}
              </span>
            )}
          </span>
          <span
            className={`shrink-0 text-right tabular-nums ${r.unexplained ? 'font-semibold text-rose-800' : ''}`}
          >
            {qty === 0 ? (r.counted ? 'no variance' : 'not counted') : formatQty(qty, r.unit)}
            {Number(r.variance_value) !== 0 && (
              <span className="block">{formatMoney(r.variance_value)}</span>
            )}
          </span>
        </summary>
        <p className="px-4 pb-3 text-xs text-slate-500" data-testid="formula">
          opening {formatQty(r.opening, r.unit)} + in {formatQty(r.came_in, r.unit)} − out{' '}
          {formatQty(r.went_out, r.unit)} − used {formatQty(r.used, r.unit)} = expected{' '}
          {formatQty(r.expected_closing, r.unit)}
          {Number(r.pending_qty) !== 0 && (
            <> · {formatQty(r.pending_qty, r.unit)} awaiting approval</>
          )}
        </p>
      </details>
    </li>
  );
}
