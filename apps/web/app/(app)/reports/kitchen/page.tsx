import Link from 'next/link';
import { Empty } from '@/components/messages';
import {
  CsvLink,
  NoReport,
  PeriodPicker,
  ReportHeader,
  ReportSections,
} from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { formatWhen } from '@/lib/format';
import { formatQty } from '@/lib/inventory';
import type { SearchParams } from '@/lib/params';
import {
  kitchenDispatch,
  kitchenInTransit,
  kitchenProduction,
  kitchenSummary,
  reportPeriod,
  reportPlace,
  reportToday,
} from '@/lib/report-data';
import { capRange, formatMeasure, trendHref } from '@/lib/reports';

// Central kitchen (R-3, ADR 030), per kitchen store: what was made against the prep lists,
// what each outlet asked for, was sent and received, what was lost on the way, and what is
// on the road now. Opens where the person sees the store's costs (the R-2 store rule).
export default async function KitchenReport({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'central_kitchen', searchParams);
    if (!place) return null;
    const range = await reportPeriod(searchParams, await reportToday(tx, place.id));
    const { from, to } = capRange(range.from, range.to);
    const [summary, production, dispatch, transit] = await Promise.all([
      kitchenSummary(tx, place.id, from, to),
      kitchenProduction(tx, place.id, from, to),
      kitchenDispatch(tx, place.id, from, to),
      kitchenInTransit(tx, place.id),
    ]);
    return { places, place, range: { ...range, from, to }, summary, production, dispatch, transit };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, range, summary, production, dispatch, transit } = data;
  return (
    <div className="space-y-4">
      <ReportHeader
        report="central_kitchen"
        switcher={{ screen: 'central_kitchen', places, current: place.id }}
      />
      <PeriodPicker
        action="/reports/kitchen"
        node={place.id}
        period={range.period}
        from={range.from}
        to={range.to}
      />
      <ReportSections
        report="central_kitchen"
        rows={summary}
        trend={(m) => trendHref('central_kitchen', place.id, m)}
      />

      <section aria-label="Made" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Made against the prep lists</h2>
        {production.length === 0 ? (
          <Empty>Nothing made or planned in this period.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="kitchen-production"
          >
            {production.map((p) => (
              <li key={p.sku} className="text-sm" data-sku={p.sku}>
                <Link
                  href={`/reports/item?node=${place.id}&item=${p.item_id}`}
                  className="flex justify-between gap-2 px-4 py-3"
                >
                  <span className="min-w-0">
                    <span className="block font-medium">{p.name}</span>
                    <span className="block text-xs text-slate-500">
                      {p.batches} {p.batches === 1 ? 'batch' : 'batches'}
                      {p.planned !== null && ` · planned ${formatQty(p.planned, p.unit)}`}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 tabular-nums ${
                      p.planned !== null && Number(p.made) < Number(p.planned)
                        ? 'text-rose-800'
                        : ''
                    }`}
                  >
                    {formatQty(p.made, p.unit)} made
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="To the outlets" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">To each outlet</h2>
        {dispatch.length === 0 ? (
          <Empty>No transfers asked for in this period.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="kitchen-dispatch"
          >
            {dispatch.map((d) => (
              <li key={d.store_id} className="text-sm" data-store={d.store_id}>
                <Link
                  href={
                    trendHref('central_kitchen', place.id, 'fill_pct', {
                      key: d.store_id,
                      name: d.store_name,
                    }) ?? ''
                  }
                  className="block space-y-1 px-4 py-3"
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{d.store_name}</span>
                    <span className="font-semibold tabular-nums" data-testid="fill">
                      {d.fill_pct === null ? '–' : `${formatMeasure('pct', d.fill_pct)} filled`}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {d.transfers} {d.transfers === 1 ? 'transfer' : 'transfers'} · asked{' '}
                    {formatMeasure('money', d.requested_value)}, sent{' '}
                    {formatMeasure('money', d.dispatched_value)}, received{' '}
                    {formatMeasure('money', d.received_value)}
                    {Number(d.transit_loss) > 0 &&
                      ` · ${formatMeasure('money', d.transit_loss)} lost on the way`}
                    {d.short_lines > 0 &&
                      ` · ${d.short_lines} ${d.short_lines === 1 ? 'line' : 'lines'} short`}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dispatch.length > 0 && (
        <CsvLink report="kitchen_dispatch" node={place.id} period={range} label="Outlets as CSV" />
      )}
      {transit.length > 0 && (
        <section aria-label="On the way" className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">On the way now</h2>
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="kitchen-in-transit"
          >
            {transit.map((t) => (
              <li key={t.transfer_id} className="flex justify-between gap-2 px-4 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">{t.store_name}</span>
                  <span className="block text-xs text-slate-500">
                    sent {formatWhen(t.dispatched_at)} · {t.lines}{' '}
                    {t.lines === 1 ? 'line' : 'lines'}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{formatMeasure('money', t.value)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs text-slate-500">
        {formatDay(range.from)} to {formatDay(range.to)}, at most 93 days. Values at the
        kitchen&apos;s cost. Filled is what was sent over what was asked for; lost on the way is
        what was sent but not received.
      </p>
    </div>
  );
}
