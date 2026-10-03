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
import type { SearchParams } from '@/lib/params';
import {
  peopleDepartments,
  peopleFlags,
  peopleLeave,
  peopleSummary,
  reportPeriod,
  reportPlace,
  reportToday,
} from '@/lib/report-data';
import { capRange, formatMeasure } from '@/lib/reports';

// People (R-3, ADR 030): headcount, shifts, lateness, hours, overtime and leave for a
// company, region, area, outlet or site. Opens with REPORTS or WORKERS modify. Names of
// who was late come back only for people who keep the records (WORKERS modify); leave in
// ₹ only with LABOUR_COST or REPORTS. rpt.* decides both.
export default async function PeopleReport({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'people', searchParams);
    if (!place) return null;
    const range = await reportPeriod(searchParams, await reportToday(tx, place.id));
    const { from, to } = capRange(range.from, range.to);
    const [summary, departments, flags, leave] = await Promise.all([
      peopleSummary(tx, place.id, from, to),
      peopleDepartments(tx, place.id, from, to),
      peopleFlags(tx, place.id, from, to),
      peopleLeave(tx, place.id, from, to),
    ]);
    return { places, place, range: { ...range, from, to }, summary, departments, flags, leave };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, range, summary, departments, flags, leave } = data;
  const money =
    leave.some((l) => l.liability !== null) ||
    summary.some((m) => m.measure === 'leave_liability' && m.value !== null);
  return (
    <div className="space-y-4">
      <ReportHeader report="people" switcher={{ screen: 'people', places, current: place.id }} />
      <PeriodPicker
        action="/reports/people"
        node={place.id}
        period={range.period}
        from={range.from}
        to={range.to}
      />
      {/* leave in ₹ only for those who see labour cost: no empty row for the others */}
      <ReportSections
        report="people"
        rows={summary.filter((m) => m.measure !== 'leave_liability' || m.value !== null)}
      />

      {departments.length > 1 && (
        <section aria-label="By department" className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">By department</h2>
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="people-departments"
          >
            {departments.map((d) => (
              <li key={d.org_node_id} className="space-y-1 px-4 py-3 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{d.name.split(' – ').pop()}</span>
                  <span className="tabular-nums">{d.headcount} people</span>
                </div>
                <p className="text-xs text-slate-500">
                  {d.shifts} {d.shifts === 1 ? 'shift' : 'shifts'}
                  {d.on_time_pct !== null && ` · ${formatMeasure('pct', d.on_time_pct)} on time`}
                  {d.late > 0 && ` · ${d.late} late`}
                  {d.no_shows > 0 &&
                    ` · ${d.no_shows} no-show${d.no_shows === 1 ? '' : 's'}`} ·{' '}
                  {formatMeasure('hours', d.hours)}
                  {Number(d.overtime_hours) > 0 &&
                    ` (${formatMeasure('hours', d.overtime_hours)} overtime)`}
                  {Number(d.leave_days) > 0 && ` · ${formatMeasure('days', d.leave_days)} leave`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {flags.length > 0 && (
        <section aria-label="Late or not in" className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">Late or did not come in</h2>
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="people-flags"
          >
            {flags.map((f) => (
              <li key={f.user_id} className="flex justify-between gap-2 px-4 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">{f.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {f.job_title} · {f.place.split(' – ').pop()}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums">
                  {f.late > 0 && <span className="block">{f.late} late</span>}
                  {f.no_shows > 0 && (
                    <span className="block text-rose-800">
                      {f.no_shows} no-show{f.no_shows === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {departments.length > 1 && (
        <CsvLink
          report="people_departments"
          node={place.id}
          period={range}
          label="Departments as CSV"
        />
      )}
      <section aria-label="Leave by type" className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Leave by type</h2>
        {leave.length === 0 ? (
          <Empty>No leave types set up.</Empty>
        ) : (
          <ul
            className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
            data-testid="people-leave"
          >
            {leave.map((l) => (
              <li key={l.leave_type} className="flex justify-between gap-2 px-4 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">{l.leave_type}</span>
                  <span className="block text-xs text-slate-500">
                    {formatMeasure('days', l.taken_days)} taken in the period
                  </span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  {formatMeasure('days', l.balance_days)} left
                  {money && (
                    <span className="block text-xs text-slate-500">
                      {formatMeasure('money', l.liability)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-slate-500">
        {formatDay(range.from)} to {formatDay(range.to)}, at most 93 days. People are counted at
        their home place. Overtime is hours over the weekly limit. Leave left is this year&apos;s;
        its value is a day&apos;s pay (8 hours for hourly staff) and is shown only for leave held by
        3 or more paid people.
      </p>
    </div>
  );
}
