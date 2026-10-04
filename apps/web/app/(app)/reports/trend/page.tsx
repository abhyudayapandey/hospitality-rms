import { failure } from '@outlet-ops/domain';
import { BackLink } from '@/components/back-link';
import {
  Accordion,
  Dishes,
  dishesSummary,
  People,
  peopleSummary,
  Readings,
  readingsSummary,
  Stock,
  stockSummary,
  Tasks,
  tasksSummary,
  Wastage,
  wastageSummary,
} from '@/components/breakdown-view';
import { CostBreakdown, NoReport } from '@/components/report-view';
import { TrendChart, TrendControls, TrendFigure, trendLink } from '@/components/trend-chart';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/params';
import { isReportScreen } from '@/lib/place-screens';
import {
  BREAKDOWN_TITLE,
  breakdownsFor,
  selectedPeriod,
  type BreakdownKind,
} from '@/lib/breakdowns';
import type { Tx } from '@/lib/db';
import {
  bdDishes,
  bdPeople,
  bdReadings,
  bdStock,
  bdTasks,
  bdWastage,
  costBreakdown,
  measureTrend,
  reportPlaces,
  reportToday,
} from '@/lib/report-data';
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
// Below the chart (ADR 042), each in a section closed until tapped: the weeks or months
// (tapping one picks it), then what is behind the figure in the picked period: the dishes,
// the wastage, the stock, the people, the tasks by person, the flagged readings.
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
  const at = param(sp, 'at');
  const data = await withUser(user.id, async (tx) => {
    try {
      await sql`savepoint trend`.execute(tx);
      const today = await reportToday(tx, node);
      const range = trendRange(view.months, by, today);
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
      // a dish's or an item's trend has its own rows; the lists are the report's
      const picked = key ? null : selectedPeriod(points, at, by, today);
      const lists = picked
        ? await loadLists(tx, breakdownsFor(report, measure), report, node, picked)
        : [];
      return { points, placeName: place?.name ?? '', picked, lists };
    } catch (err) {
      await sql`rollback to savepoint trend`.execute(tx);
      const f = failure(err);
      return { refused: f.code === 'NOT_AUTHORISED' ? NO_ACCESS : f.message };
    }
  });
  if ('refused' in data) return <NoReport>{data.refused}</NoReport>;
  const { points, placeName, picked, lists } = data;
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
      <Accordion
        title={by === 'week' ? 'By week' : 'By month'}
        summary={`${points.length} ${by === 'week' ? 'weeks' : 'months'}${
          picked && lists.length > 0 ? ' · tap one to see what is behind it' : ''
        }`}
        testId="trend-periods"
      >
        <ul className="divide-y divide-slate-100" data-testid="trend-rows">
          {[...points].reverse().map((p) => {
            const on = picked?.from === p.period;
            const row = (
              <>
                <span className="font-medium">{trendLabel(by, p.period)}</span>
                <span className="tabular-nums">{fmt(p.value)}</span>
              </>
            );
            return (
              <li key={p.period} data-period={p.period}>
                {picked && lists.length > 0 ? (
                  <a
                    href={`${trendLink(base, view, {})}&at=${p.period}`}
                    aria-current={on ? 'true' : undefined}
                    className={`flex min-h-11 items-center justify-between gap-2 px-4 py-2 text-sm ${
                      on ? 'bg-brand-50 font-semibold' : ''
                    }`}
                  >
                    {row}
                  </a>
                ) : (
                  <span className="flex justify-between gap-2 px-4 py-3 text-sm">{row}</span>
                )}
              </li>
            );
          })}
        </ul>
      </Accordion>
      {picked && lists.length > 0 && (
        <section aria-label="What is behind it" className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700" data-testid="breakdown-period">
            What is behind it · {trendLabel(by, picked.from)}
          </h2>
          {lists.map((l) => (
            <Accordion
              key={l.kind}
              title={BREAKDOWN_TITLE[l.kind]}
              summary={l.summary}
              testId={`breakdown-${l.kind}`}
            >
              {l.body}
            </Accordion>
          ))}
        </section>
      )}
      <p className="text-xs text-slate-500">
        {by === 'week' ? 'Weeks start on Monday' : 'Months start on the 1st'}; business days run
        04:00 to 04:00.{' '}
        {def.unit === 'pct'
          ? `Each ${by}'s share is worked out from its own totals, not an average of days.`
          : measure === 'stock_value'
            ? `Each ${by} shows the stock held at its end.`
            : ''}
      </p>
    </div>
  );
}

type Picked = { from: string; to: string };
type List = { kind: BreakdownKind; summary: string; body: React.ReactNode };

const NO_PEOPLE =
  'Names show only for people who see the team here; you see the totals on the report.';

/** Each list in its own savepoint, so a list refused (no team access) leaves the rest. */
async function loadLists(
  tx: Tx,
  kinds: readonly BreakdownKind[],
  report: string,
  node: string,
  { from, to }: Picked,
): Promise<List[]> {
  const out: List[] = [];
  for (const kind of kinds) {
    await sql`savepoint bd`.execute(tx);
    try {
      out.push(await loadList(tx, kind, report, node, from, to));
    } catch (err) {
      await sql`rollback to savepoint bd`.execute(tx);
      const f = failure(err);
      // an unexpected error is a bug: let it show; a refusal or a module off skips the list
      if (f.code === 'UNEXPECTED') throw err;
      if (
        f.code === 'NOT_AUTHORISED' &&
        (kind === 'people' || kind === 'tasks' || kind === 'readings')
      ) {
        out.push({
          kind,
          summary: 'Names not shown',
          body: <p className="px-4 py-3 text-sm text-slate-500">{NO_PEOPLE}</p>,
        });
      }
    }
  }
  return out;
}

async function loadList(
  tx: Tx,
  kind: BreakdownKind,
  report: string,
  node: string,
  from: string,
  to: string,
): Promise<List> {
  switch (kind) {
    case 'dishes': {
      const rows = await bdDishes(tx, report, node, from, to);
      return { kind, summary: dishesSummary(rows), body: <Dishes rows={rows} /> };
    }
    case 'wastage': {
      const rows = await bdWastage(tx, report, node, from, to);
      return { kind, summary: wastageSummary(rows), body: <Wastage rows={rows} /> };
    }
    case 'stock': {
      const rows = await bdStock(tx, report, node);
      return { kind, summary: stockSummary(rows), body: <Stock rows={rows} /> };
    }
    case 'cost': {
      const rows = await costBreakdown(tx, node, from, to);
      const total =
        rows.find((r) => r.part === 'prime') ?? rows.find((r) => r.part === 'materials');
      return {
        kind,
        summary: `Total cost ${formatMeasure('money', total?.value ?? null)}`,
        body: (
          <div className="p-2">
            <CostBreakdown rows={rows} titled={false} />
          </div>
        ),
      };
    }
    case 'people': {
      const rows = await bdPeople(tx, report, node, from, to);
      return { kind, summary: peopleSummary(rows), body: <People rows={rows} /> };
    }
    case 'tasks': {
      const rows = await bdTasks(tx, report, node, from, to);
      return { kind, summary: tasksSummary(rows), body: <Tasks rows={rows} /> };
    }
    case 'readings': {
      const rows = await bdReadings(tx, report, node, from, to);
      return { kind, summary: readingsSummary(rows), body: <Readings rows={rows} /> };
    }
  }
}
