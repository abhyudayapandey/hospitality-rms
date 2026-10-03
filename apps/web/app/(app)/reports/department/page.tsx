import { DayPicker, NoReport, ReportHeader, ReportSections } from '@/components/report-view';
import { requireUser } from '@/lib/auth/server';
import { formatSpan } from '@/lib/dates';
import { withUser } from '@/lib/db';
import { companySettings } from '@/lib/settings-data';
import { jobTitles } from '@/lib/job-titles';
import type { SearchParams } from '@/lib/params';
import {
  departmentDay,
  departmentPeople,
  reportDay,
  reportPlace,
  reportToday,
} from '@/lib/report-data';

// A department's day: who is on shift and who hasn't clocked in (today), hours, open
// slots and tasks; its store's wastage and stock where the person sees that store.
export default async function DepartmentReport({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const { places, place } = await reportPlace(tx, 'department', searchParams);
    if (!place) return null;
    const today = await reportToday(tx, place.id);
    const day = await reportDay(searchParams, today);
    return {
      places,
      place,
      today,
      day,
      rows: await departmentDay(tx, place.id, day),
      people: day === today ? await departmentPeople(tx, place.id) : [],
      title: await jobTitles(tx),
      targets: (await companySettings(tx)).targets,
    };
  });
  if (!data) return <NoReport>You don&apos;t have access to this report.</NoReport>;
  const { places, place, today, day, rows, people, title, targets } = data;
  const now = new Date();
  return (
    <div className="space-y-4">
      <ReportHeader
        report="department"
        switcher={{ screen: 'department', places, current: place.id }}
      />
      <DayPicker
        href={(d) => `/reports/department?node=${place.id}&day=${d}`}
        day={day}
        today={today}
      />
      {day === today && (
        <section aria-label="On shift today" className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">On shift today</h2>
          {people.length === 0 ? (
            <p className="text-sm text-slate-600">No one is rostered today.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
              {people.map((p, i) => {
                const started = new Date(p.start_at) <= now;
                const state = p.clocked_out_at
                  ? 'Done'
                  : p.clocked_in_at
                    ? 'In'
                    : started
                      ? 'Not in yet'
                      : 'Later';
                return (
                  <li
                    key={`${p.name}-${i}`}
                    className="flex items-center justify-between gap-2 p-3"
                    data-testid="on-shift"
                  >
                    <span>
                      <span className="block font-medium">{p.name}</span>
                      <span className="block text-xs text-slate-500">
                        {title(p.role_code)} · {formatSpan(p.start_at, p.end_at)}
                      </span>
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        state === 'Not in yet'
                          ? 'bg-rose-50 text-rose-800'
                          : state === 'In'
                            ? 'bg-emerald-50 text-emerald-800'
                            : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {state}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      <ReportSections report="department" rows={rows} targets={targets} />
    </div>
  );
}
