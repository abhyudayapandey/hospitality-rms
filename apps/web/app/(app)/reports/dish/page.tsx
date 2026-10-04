import { failure } from '@outlet-ops/domain';
import { BackLink } from '@/components/back-link';
import { NoReport } from '@/components/report-view';
import { TrendChart, TrendControls, TrendFigure, trendLink } from '@/components/trend-chart';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { param, type SearchParams } from '@/lib/params';
import { dishTrend, reportPlace, reportToday } from '@/lib/report-data';
import { trendLabel, trendRange, trendSettings } from '@/lib/reports';

// A dish's trend at an outlet (RPT-12, ADR 041), opened from its row in Menu engineering:
// sold, sales (what the POS took, after discount), recipe cost and margin over the last 3,
// 6, 9 or 12 months, by week or month, as a line or bars. rpt.dish_trend opens exactly
// where menu engineering does.
export default async function DishTrend({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const item = param(sp, 'item');
  const view = trendSettings({
    months: param(sp, 'months'),
    by: param(sp, 'by'),
    chart: param(sp, 'chart'),
  });
  const { by } = view;
  const data = await withUser(user.id, async (tx) => {
    const { place } = await reportPlace(tx, 'menu_engineering', searchParams);
    // the outlet asked for, not the remembered one: a row opens its own outlet's dish
    if (!place || place.id !== param(sp, 'node') || !/^[0-9a-f-]{36}$/.test(item)) return null;
    const range = trendRange(view.months, by, await reportToday(tx, place.id));
    try {
      await sql`savepoint trend`.execute(tx);
      const points = await dishTrend(tx, place.id, item, by, range.from, range.to);
      return { place, range, points, dish: points[0]?.dish ?? 'Dish' };
    } catch (err) {
      await sql`rollback to savepoint trend`.execute(tx);
      const f = failure(err);
      return {
        refused: f.code === 'NOT_AUTHORISED' ? "You don't have access to this report." : f.message,
      };
    }
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  if ('refused' in data) return <NoReport>{data.refused}</NoReport>;
  const { place, points, dish } = data;
  const sum = (k: 'sold' | 'sales' | 'discount' | 'cost' | 'margin') =>
    points.reduce((s, p) => s + Number(p[k]), 0);
  const sales = sum('sales');
  const costPct = sales > 0 ? (sum('cost') / sales) * 100 : null;
  const base = `/reports/dish?node=${place.id}&item=${item}`;
  return (
    <div className="space-y-4">
      <BackLink fallback={`/reports/menu?node=${place.id}&months=${view.months}`} />
      <div>
        <h1 className="text-xl font-semibold" data-testid="trend-title">
          {dish}
        </h1>
        <p className="text-sm text-slate-600">{place.name}</p>
      </div>
      <TrendControls view={view} href={(c) => trendLink(base, view, c)} />
      <dl className="grid grid-cols-2 gap-2 text-sm" data-testid="trend-totals">
        <TrendFigure label="Sold" value={String(sum('sold'))} />
        <TrendFigure label="Sales" value={formatMoney(sales) ?? '–'} />
        <TrendFigure
          label="Recipe cost"
          value={`${formatMoney(sum('cost'))}${costPct === null ? '' : ` · ${costPct.toFixed(1)}%`}`}
        />
        <TrendFigure label="Margin" value={formatMoney(sum('margin')) ?? '–'} />
        {sum('discount') > 0 && (
          <TrendFigure label="Discount" value={formatMoney(sum('discount')) ?? '–'} />
        )}
      </dl>
      <TrendChart
        kind={view.chart}
        title={`Sales and recipe cost of ${dish} by ${by}`}
        labels={points.map((p) => trendLabel(by, p.period))}
        format={(v) => formatMoney(v) ?? ''}
        stacked={view.chart === 'bar'}
        series={
          view.chart === 'bar'
            ? [
                { label: 'cost', tone: 'warn', values: points.map((p) => Number(p.cost)) },
                {
                  label: 'margin',
                  tone: 'brand',
                  values: points.map((p) => Math.max(0, Number(p.margin))),
                },
              ]
            : [
                { label: 'sales', tone: 'brand', values: points.map((p) => Number(p.sales)) },
                { label: 'recipe cost', tone: 'warn', values: points.map((p) => Number(p.cost)) },
              ]
        }
      />
      <ul
        className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
        data-testid="trend-rows"
      >
        {[...points].reverse().map((p) => (
          <li
            key={p.period}
            className="flex justify-between gap-2 px-4 py-3 text-sm"
            data-period={p.period}
          >
            <span className="min-w-0">
              <span className="block font-medium">{trendLabel(by, p.period)}</span>
              <span className="block text-xs text-slate-500 tabular-nums">
                {Number(p.sold)} sold · cost {formatMoney(p.cost)}
                {Number(p.discount) > 0 ? ` · ${formatMoney(p.discount)} off` : ''}
              </span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              {formatMoney(p.sales)}
              <span className="block text-xs text-slate-500">margin {formatMoney(p.margin)}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">
        Sales are what the POS took after discount (typed-in sales at the menu price). Cost is the
        recipe at each day&apos;s average cost, as in Menu engineering.
      </p>
    </div>
  );
}
