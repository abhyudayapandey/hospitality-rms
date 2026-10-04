import {
  CostBreakdown,
  DayPicker,
  NoReport,
  ReportHeader,
  ReportSections,
} from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { companySettings } from '@/lib/settings-data';
import type { SearchParams } from '@/lib/params';
import { outletFlash, reportDay, reportPlace, reportToday } from '@/lib/report-data';
import { flashCostParts, trendHref } from '@/lib/reports';

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
    };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, today, day, rows, targets } = data;
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
      <p className="text-xs text-slate-500">
        Business day 04:00 to 04:00. Cost is the recipe cost of what sold; sales come from the daily
        sales entry until the POS import. People cost is hours worked at the hourly rate, and a
        day&apos;s pay (a year&apos;s salary over 365) for salaried staff; overtime at the normal
        rate.
      </p>
    </div>
  );
}
