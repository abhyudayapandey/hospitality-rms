import { failure } from '@outlet-ops/domain';
import { BackLink } from '@/components/back-link';
import { NoReport } from '@/components/report-view';
import { TrendChart, TrendControls, TrendFigure, trendLink } from '@/components/trend-chart';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/params';
import { isReportScreen } from '@/lib/place-screens';
import { measureTrend, reportPlaces, reportToday } from '@/lib/report-data';
import {
  formatMeasure,
  isReportCode,
  MEASURES,
  REPORTS,
  trendLabel,
  trendRange,
  trendSettings,
} from '@/lib/reports';

// Any figure of a report over time (RPT-12, ADR 041): opened by tapping it on Outlet
// today, Department, Cost of sales, Stock position, People, the central kitchen, a
// supplier on Purchasing or an outlet's cell in Outlets side by side. The last 3, 6, 9 or
// 12 months, by week or month, as a line or bars. rpt.measure_trend opens exactly where
// the report opens, and labour only for people who see labour there.
const NO_ACCESS = "You don't have access to this report.";
const UUID = /^[0-9a-f-]{36}$/;

export default async function MeasureTrend({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const report = param(sp, 'report');
  const node = param(sp, 'node');
  const measure = param(sp, 'measure');
  const key = param(sp, 'key');
  const def = MEASURES[measure];
  if (
    !isReportCode(report) ||
    !isReportScreen(report) ||
    !UUID.test(node) ||
    (key !== '' && !UUID.test(key)) ||
    !def
  ) {
    return <NoReport>{NO_ACCESS}</NoReport>;
  }
  const view = trendSettings({
    months: param(sp, 'months'),
    by: param(sp, 'by'),
    chart: param(sp, 'chart'),
  });
  const { by } = view;
  const data = await withUser(user.id, async (tx) => {
    try {
      await sql`savepoint trend`.execute(tx);
      const range = trendRange(view.months, by, await reportToday(tx, node));
      const points = await measureTrend(
        tx,
        report,
        node,
        measure,
        by,
        range.from,
        range.to,
        key || null,
      );
      const place = (await reportPlaces(tx, report)).find((p) => p.id === node);
      return { points, placeName: place?.name ?? '' };
    } catch (err) {
      await sql`rollback to savepoint trend`.execute(tx);
      const f = failure(err);
      return { refused: f.code === 'NOT_AUTHORISED' ? NO_ACCESS : f.message };
    }
  });
  if ('refused' in data) return <NoReport>{data.refused}</NoReport>;
  const { points, placeName } = data;
  const fmt = (v: string | number | null) => formatMeasure(def.unit, v);
  const values = points.map((p) => (p.value === null ? null : Number(p.value)));
  const shown = values.filter((v): v is number => v !== null);
  const average = shown.length > 0 ? shown.reduce((s, v) => s + v, 0) / shown.length : null;
  // a share or a value held at the end of each period does not add up over periods
  const adds = def.unit !== 'pct' && measure !== 'stock_value';
  const latest = [...points].reverse().find((p) => p.value !== null);
  const name = param(sp, 'name');
  const base = `/reports/trend?report=${report}&node=${node}&measure=${measure}${
    key ? `&key=${key}&name=${encodeURIComponent(name)}` : ''
  }`;
  const per = by === 'week' ? 'a week' : 'a month';
  return (
    <div className="space-y-4">
      <BackLink fallback={`${REPORTS[report].href}?node=${node}`} />
      <div>
        <h1 className="text-xl font-semibold" data-testid="trend-title">
          {def.label}
          {name ? ` · ${name}` : ''}
        </h1>
        <p className="text-sm text-slate-600">
          {REPORTS[report].title}
          {placeName ? ` · ${placeName}` : ''}
        </p>
      </div>
      <TrendControls view={view} href={(c) => trendLink(base, view, c)} />
      <dl className="grid grid-cols-2 gap-2 text-sm" data-testid="trend-totals">
        {adds ? (
          <TrendFigure
            label={`${view.months} months`}
            value={fmt(shown.reduce((s, v) => s + v, 0))}
          />
        ) : (
          <TrendFigure
            label={latest ? trendLabel(by, latest.period) : 'Latest'}
            value={fmt(latest?.value ?? null)}
          />
        )}
        <TrendFigure label={`Average ${per}`} value={fmt(average)} />
      </dl>
      <TrendChart
        kind={view.chart}
        title={`${def.label} by ${by}`}
        labels={points.map((p) => trendLabel(by, p.period))}
        format={(v) => fmt(v)}
        series={[{ label: def.label, tone: def.better === 'down' ? 'warn' : 'brand', values }]}
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
            <span className="font-medium">{trendLabel(by, p.period)}</span>
            <span className="tabular-nums">{fmt(p.value)}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">
        {by === 'week' ? 'Weeks start on Monday' : 'Months start on the 1st'}; business days run
        06:00 to 06:00.{' '}
        {def.unit === 'pct'
          ? `Each ${by}'s share is worked out from its own totals, not an average of days.`
          : measure === 'stock_value'
            ? `Each ${by} shows the stock held at its end.`
            : ''}
      </p>
    </div>
  );
}
