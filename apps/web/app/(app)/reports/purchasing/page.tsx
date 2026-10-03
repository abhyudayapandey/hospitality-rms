import { Empty } from '@/components/messages';
import { NoReport, PeriodPicker, ReportHeader } from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { formatQty } from '@/lib/inventory';
import type { SearchParams } from '@/lib/params';
import {
  priceChanges,
  reportPeriod,
  reportPlace,
  reportToday,
  shortDeliveries,
  supplierFill,
} from '@/lib/report-data';

// Purchasing (R-2, ADR 028), per store: price changes (each receipt against the store's
// previous price for the item, else its standard cost) and each supplier's fill rate and
// timeliness, with the lines delivered short or not at all.
export default async function Purchasing({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'purchasing', searchParams);
    if (!place) return null;
    const sp = await searchParams;
    // four weeks by default: orders are less frequent than sales
    const range = await reportPeriod(
      Promise.resolve({ period: 'four_weeks', ...sp }),
      await reportToday(tx, place.id),
    );
    return {
      places,
      place,
      range,
      prices: await priceChanges(tx, place.id, range.from, range.to),
      fill: await supplierFill(tx, place.id, range.from, range.to),
      short: await shortDeliveries(tx, place.id, range.from, range.to),
    };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, range, prices, fill, short } = data;
  const changed = prices.filter((p) => Number(p.change_value ?? 0) !== 0);
  const total = changed.reduce((t, p) => t + Number(p.change_value), 0);
  return (
    <div className="space-y-4">
      <ReportHeader
        report="purchasing"
        switcher={{ screen: 'purchasing', places, current: place.id }}
      />
      <PeriodPicker
        action="/reports/purchasing"
        node={place.id}
        period={range.period}
        from={range.from}
        to={range.to}
      />

      <section aria-label="Price changes" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">
          Price changes
          {changed.length > 0 && (
            <span data-testid="price-change-total">
              {' '}
              · {total > 0 ? 'paid' : 'saved'} {formatMoney(Math.abs(total))}
            </span>
          )}
        </h2>
        {changed.length === 0 ? (
          <Empty>No price changes on what was received in this period.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="price-changes"
          >
            {changed.map((p, i) => (
              <li key={i} className="flex justify-between gap-2 px-4 py-3 text-sm" data-sku={p.sku}>
                <span className="min-w-0">
                  <span className="block font-medium">{p.name}</span>
                  <span className="block text-xs text-slate-500">
                    {formatMoney(p.unit_cost)} a {p.unit}, was {formatMoney(p.previous_cost)}
                    {p.basis === 'standard' && ' (standard cost)'} · {formatQty(p.qty, p.unit)} from{' '}
                    {p.supplier} · {formatDay(p.received_at.slice(0, 10))}
                  </span>
                </span>
                <span
                  className={`shrink-0 tabular-nums ${Number(p.change_value) > 0 ? 'text-rose-800' : 'text-emerald-700'}`}
                >
                  {Number(p.change_value) > 0 ? '+' : '−'}
                  {formatMoney(Math.abs(Number(p.change_value)))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Suppliers" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Suppliers</h2>
        {fill.length === 0 ? (
          <Empty>No orders released in this period.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="supplier-fill"
          >
            {fill.map((f) => (
              <li
                key={f.supplier}
                className="space-y-1 px-4 py-3 text-sm"
                data-supplier={f.supplier}
              >
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{f.supplier}</span>
                  <span className="tabular-nums font-semibold" data-testid="fill">
                    {f.fill_pct === null ? '–' : `${Number(f.fill_pct)}% delivered`}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  {f.orders} {f.orders === 1 ? 'order' : 'orders'} · {f.on_time} on time
                  {f.late > 0 && ` · ${f.late} late`}
                  {f.not_delivered > 0 && ` · ${f.not_delivered} not delivered`}
                  {f.not_due > 0 && ` · ${f.not_due} not due yet`} · {formatMoney(f.received_value)}{' '}
                  of {formatMoney(f.ordered_value)}
                </p>
              </li>
            ))}
          </ul>
        )}
        {short.length > 0 && (
          <details className="rounded-xl bg-white ring-1 ring-slate-200">
            <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium">
              Delivered short or not at all ({short.length})
            </summary>
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {short.map((s, i) => (
                <li key={i} className="flex justify-between gap-2 px-4 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium">{s.name}</span>
                    <span className="block text-xs text-slate-500">
                      {s.supplier} · ordered {formatDay(s.released_on)}, due {formatDay(s.due_on)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    {formatQty(s.received, s.unit)} of {formatQty(s.ordered, s.unit)}
                    <span className="block text-xs text-slate-500">
                      {formatMoney(s.short_value)} short
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <p className="text-xs text-slate-500">
        Orders released {formatDay(range.from)} to {formatDay(range.to)}. Fill rate is what was
        received over what was ordered, at the ordered price; on time is a first delivery by the
        order day plus the supplier&apos;s lead time.
      </p>
    </div>
  );
}
