import {
  CostBreakdown,
  DayPicker,
  NoReport,
  ReportHeader,
  ReportSections,
} from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { coversDay, salesOn, type CoversRow } from '@/lib/covers';
import { withUser } from '@/lib/db';
import { formatMoney } from '@/lib/format';
import { companySettings } from '@/lib/settings-data';
import type { SearchParams } from '@/lib/params';
import { outletFlash, reportDay, reportPlace, reportToday } from '@/lib/report-data';
import { flashCostParts, trendHref } from '@/lib/reports';
import { CoversForm } from './covers-form';

// The outlet's day (the daily flash, docs/reporting.md): sales, recipe cost %, wastage,
// stock, hours and tasks, each against the same day last week. Opens where the person
// sees the outlet's sales, or with REPORTS (the Account Owner). People cost, People cost %
// and Materials % (shares of the total cost, ADR 042) and prime cost only for people who
// see labour cost (R-3, ADR 030); rpt.outlet_flash leaves
// them out for everyone else.
export default async function OutletReport({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'outlet_flash', searchParams);
    if (!place) return null;
    const today = await reportToday(tx, place.id);
    const day = await reportDay(searchParams, today);
    return {
      places,
      place,
      today,
      day,
      rows: await outletFlash(tx, place.id, day),
      targets: (await companySettings(tx)).targets,
      covers: (await salesOn(tx)) ? await coversDay(tx, place.id, day) : null,
    };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, today, day, rows, targets, covers } = data;
  return (
    <div className="space-y-4">
      <ReportHeader
        report="outlet_flash"
        switcher={{ screen: 'outlet_flash', places, current: place.id }}
      />
      <DayPicker
        href={(d) => `/reports/outlet?node=${place.id}&day=${d}`}
        day={day}
        today={today}
      />
      <ReportSections
        report="outlet_flash"
        rows={rows}
        targets={targets}
        trend={(m) => trendHref('outlet_flash', place.id, m)}
      />
      <CostBreakdown rows={flashCostParts(rows)} />
      {covers && <Covers outlet={place.id} day={day} rows={covers} />}
      <p className="text-xs text-slate-500">
        Business day 04:00 to 04:00. Cost is the recipe cost of what sold; sales come from the daily
        sales entry until the POS import. People cost is hours worked at the hourly rate, and a
        day&apos;s pay (a year&apos;s salary over 365) for salaried staff; overtime at the normal
        rate.
      </p>
    </div>
  );
}

const PERIOD: Record<CoversRow['period'], string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

/** The day's covers per meal period and the spend per cover: the day's sales over them. */
function Covers({ outlet, day, rows }: { outlet: string; day: string; rows: CoversRow[] }) {
  const first = rows[0];
  const given = { breakfast: null, lunch: null, dinner: null } as Record<
    CoversRow['period'],
    number | null
  >;
  for (const r of rows) given[r.period] = r.covers;
  return (
    <section
      className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
      data-testid="covers"
    >
      <h2 className="font-semibold">Covers</h2>
      <p className="text-sm">
        <span data-testid="covers-total">{first?.total_covers ?? 0}</span> covers
        {first?.per_cover && (
          <>
            {' · '}
            <span data-testid="per-cover">{formatMoney(first.per_cover)}</span> a cover (
            {formatMoney(first.sales)} sales)
          </>
        )}
      </p>
      {first?.can_edit ? (
        <CoversForm key={`${outlet}-${day}`} outlet={outlet} day={day} given={given} />
      ) : (
        <ul className="text-sm text-slate-600">
          {rows.map((r) => (
            <li key={r.period}>
              {PERIOD[r.period]}: {r.covers ?? '–'}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
