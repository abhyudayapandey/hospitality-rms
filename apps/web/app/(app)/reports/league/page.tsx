import Link from 'next/link';
import { Empty } from '@/components/messages';
import { NoReport, PeriodPicker, ReportHeader } from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { formatDay } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { param, type SearchParams } from '@/lib/params';
import { league, reportPeriod, reportPlace, reportToday } from '@/lib/report-data';
import {
  capRange,
  formatMeasure,
  isLeagueColumn,
  LEAGUE_COLUMNS,
  sortLeague,
  type LeagueColumn,
} from '@/lib/reports';
import { TARGET_OF, vsTarget } from '@/lib/settings';
import { companySettings } from '@/lib/settings-data';

// Outlets side by side (the league table, R-4, ADR 031): the outlets of a company, region or
// area over a period, each figure against the company's target, never one blended number.
// rpt.league decides who sees which outlet, and labour and prime cost only where the person
// sees labour cost (never for fewer than 3 paid people).
export default async function LeagueReport({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const sort: LeagueColumn = isLeagueColumn(param(sp, 'sort'))
    ? (param(sp, 'sort') as LeagueColumn)
    : 'sales';
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'league', searchParams);
    if (!place) return null;
    const asked = await reportPeriod(searchParams, await reportToday(tx, place.id));
    const range = { ...asked, ...capRange(asked.from, asked.to, 35) };
    return {
      places,
      place,
      range,
      rows: await league(tx, place.id, range.from, range.to),
      targets: (await companySettings(tx)).targets,
    };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, range, rows, targets } = data;
  const sorted = sortLeague(rows, sort);
  const query = `node=${place.id}&period=${range.period}&from=${range.from}&to=${range.to}`;
  return (
    <div className="space-y-4">
      <ReportHeader report="league" switcher={{ screen: 'league', places, current: place.id }} />
      <PeriodPicker
        action="/reports/league"
        node={place.id}
        period={range.period}
        from={range.from}
        to={range.to}
      />
      {rows.length === 0 ? (
        <Empty>No outlets to compare here.</Empty>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4">
          <table
            className="w-full min-w-[640px] border-separate border-spacing-0 text-sm"
            data-testid="league"
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 bg-slate-50 py-2 pr-3 text-left font-semibold"
                >
                  Outlet
                </th>
                {LEAGUE_COLUMNS.map((c) => {
                  const key = TARGET_OF[c.key];
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      className="px-2 py-2 text-right align-bottom font-semibold"
                    >
                      <Link
                        href={`/reports/league?${query}&sort=${c.key}`}
                        aria-current={sort === c.key ? 'true' : undefined}
                        className={`inline-flex min-h-11 flex-col items-end justify-end ${sort === c.key ? 'underline' : ''}`}
                      >
                        {c.label}
                        {key && (
                          <span className="text-xs font-normal text-slate-500">
                            target {formatMeasure('pct', targets[key])}
                          </span>
                        )}
                      </Link>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.outlet_id} data-code={r.code}>
                  <th
                    scope="row"
                    className="sticky left-0 border-t border-slate-200 bg-slate-50 py-2 pr-3 text-left font-medium"
                  >
                    <Link href={`/reports/outlet?node=${r.outlet_id}`} className="underline">
                      {r.name}
                    </Link>
                  </th>
                  {LEAGUE_COLUMNS.map((c) => {
                    const v = r[c.key];
                    const t = vsTarget(c.key, v, targets);
                    return (
                      <td
                        key={c.key}
                        data-col={c.key}
                        data-target={t.state}
                        className={`border-t border-slate-200 px-2 py-2 text-right tabular-nums ${
                          t.state === 'bad' ? 'font-semibold text-rose-700' : ''
                        }`}
                      >
                        {formatMeasure(c.key === 'sales' ? 'money' : 'pct', v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <a
        href={`/reports/csv/league?${query}`}
        className="inline-flex min-h-11 items-center text-sm text-slate-700 underline"
        data-testid="csv"
      >
        Download CSV
      </a>
      <p className="text-xs text-slate-500">
        {formatDay(range.from)} to {formatDay(range.to)}, at most 35 days. Costs are a share of
        sales: food and drinks by the recipes, prime cost is all raw materials plus people. Red is
        more than 2 points worse than the target. People and prime cost show only where you see
        labour cost, and not for an outlet with fewer than 3 paid people.
      </p>
    </div>
  );
}
