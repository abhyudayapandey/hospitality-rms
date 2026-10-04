import { failure } from '@outlet-ops/domain';
import { BackLink } from '@/components/back-link';
import { Accordion } from '@/components/breakdown-view';
import { NoReport } from '@/components/report-view';
import {
  TrendChart,
  TrendControls,
  TrendFigure,
  trendLink,
  type TrendSeries,
} from '@/components/trend-chart';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { formatQty } from '@/lib/inventory';
import { param, type SearchParams } from '@/lib/params';
import { itemTrend, reportToday } from '@/lib/report-data';
import { trendLabel, trendRange, trendSettings } from '@/lib/reports';

// A stock item's trend at one store (RPT-12, ADR 041), opened from its row in Cost of
// sales, Stock position or Purchasing: what came in and the price paid, what was used and
// wasted, and the stock left, over the last 3, 6, 9 or 12 months by week or month. rpt.item_trend opens exactly where
// the stock position opens for that store.
export default async function ItemTrend({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const store = param(sp, 'node');
  const item = param(sp, 'item');
  const view = trendSettings({
    months: param(sp, 'months'),
    by: param(sp, 'by'),
    chart: param(sp, 'chart'),
  });
  const { by } = view;
  const uuid = /^[0-9a-f-]{36}$/;
  if (!uuid.test(store) || !uuid.test(item)) {
    return <NoReport>You don&apos;t have access to this report.</NoReport>;
  }
  const data = await withUser(user.id, async (tx) => {
    try {
      await sql`savepoint trend`.execute(tx);
      const range = trendRange(view.months, by, await reportToday(tx, store));
      const points = await itemTrend(tx, store, item, by, range.from, range.to);
      const name = await sql<{ name: string }>`
        select name from rpt.report_places('stock_position') where id = ${store}::uuid`.execute(tx);
      return { points, storeName: name.rows[0]?.name ?? '' };
    } catch (err) {
      await sql`rollback to savepoint trend`.execute(tx);
      const f = failure(err);
      return {
        refused: f.code === 'NOT_AUTHORISED' ? "You don't have access to this report." : f.message,
      };
    }
  });
  if ('refused' in data) return <NoReport>{data.refused}</NoReport>;
  const { points, storeName } = data;
  const first = points[0];
  const unit = first?.unit ?? '';
  const sum = (
    k: 'came_in' | 'received_value' | 'used' | 'used_value' | 'wasted' | 'wasted_value',
  ) => points.reduce((s, p) => s + Number(p[k]), 0);
  const bought = points.filter((p) => p.avg_price !== null);
  const base = `/reports/item?node=${store}&item=${item}`;
  return (
    <div className="space-y-4">
      <BackLink fallback={`/reports/stock?node=${store}`} />
      <div>
        <h1 className="text-xl font-semibold" data-testid="trend-title">
          {first?.item ?? 'Item'}
        </h1>
        <p className="text-sm text-slate-600">{storeName}</p>
      </div>
      <TrendControls view={view} href={(c) => trendLink(base, view, c)} />
      <dl className="grid grid-cols-2 gap-2 text-sm" data-testid="trend-totals">
        <TrendFigure
          label="Used"
          value={`${formatQty(sum('used'), unit)} · ${formatMoney(sum('used_value'))}`}
        />
        <TrendFigure
          label="Wasted"
          value={`${formatQty(sum('wasted'), unit)} · ${formatMoney(sum('wasted_value'))}`}
        />
        <TrendFigure label="Bought" value={formatMoney(sum('received_value')) ?? '–'} />
        <TrendFigure label="In stock now" value={formatQty(points.at(-1)?.closing ?? 0, unit)} />
      </dl>
      <TrendChart
        kind={view.chart}
        title={`Use of ${first?.item ?? 'the item'} by ${by}`}
        labels={points.map((p) => trendLabel(by, p.period))}
        format={(v) => formatMoney(v) ?? ''}
        stacked={view.chart === 'bar'}
        series={(
          [
            { label: 'used', tone: 'brand', values: points.map((p) => Number(p.used_value)) },
            { label: 'wasted', tone: 'bad', values: points.map((p) => Number(p.wasted_value)) },
            { label: 'bought', tone: 'warn', values: points.map((p) => Number(p.received_value)) },
          ] satisfies TrendSeries[]
        ).filter((s) => view.chart === 'line' || s.label !== 'bought')}
      />
      {bought.length > 0 && (
        <p className="text-sm text-slate-600" data-testid="trend-price">
          Price paid:{' '}
          {bought
            .map((p) => `${formatMoney(p.avg_price)} (${trendLabel(by, p.period)})`)
            .join(', ')}
          , a {unit}
        </p>
      )}
      <Accordion
        title={by === 'week' ? 'By week' : 'By month'}
        summary={`${points.length} ${by === 'week' ? 'weeks' : 'months'}`}
        testId="trend-periods"
      >
        <ul className="divide-y divide-slate-100" data-testid="trend-rows">
          {[...points].reverse().map((p) => (
            <li
              key={p.period}
              className="flex justify-between gap-2 px-4 py-3 text-sm"
              data-period={p.period}
            >
              <span className="min-w-0">
                <span className="block font-medium">{trendLabel(by, p.period)}</span>
                <span className="block text-xs text-slate-500 tabular-nums">
                  in {formatQty(p.came_in, unit)} · used {formatQty(p.used, unit)}
                  {Number(p.wasted) > 0 ? ` · wasted ${formatQty(p.wasted, unit)}` : ''}
                  {Number(p.sent_out) > 0 ? ` · sent ${formatQty(p.sent_out, unit)}` : ''}
                  {Number(p.counted) !== 0 ? ` · count ${formatQty(p.counted, unit)}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-right tabular-nums">
                {formatQty(p.closing, unit)}
                <span className="block text-xs text-slate-500">left</span>
              </span>
            </li>
          ))}
        </ul>
      </Accordion>
      <p className="text-xs text-slate-500">
        In: received, transferred in and made here. Used: sold by recipe, made into prep and other
        use, valued at the store&apos;s average cost. Business days run 06:00 to 06:00.
      </p>
    </div>
  );
}
