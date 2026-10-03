import { formatMeasure } from '@/lib/reports';
import type { LabourRow } from '@/lib/report-data';

/**
 * People cost by department (R-3, ADR 030). A department with fewer than 3 paid people is
 * part of "Other departments" on that day, so no one's pay can be worked out; a department
 * shown on some days only says how many.
 */
export function LabourByDepartment({ rows }: { rows: LabourRow[] }) {
  const whole = rows.find((r) => r.part === 'outlet');
  if (!whole) return null;
  const parts = rows.filter((r) => r.part !== 'outlet');
  return (
    <section aria-label="People cost" className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-700">People cost by department</h2>
      <ul
        className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
        data-testid="labour-by-department"
      >
        {parts.map((r) => (
          <li
            key={`${r.org_node_id} ${r.part}`}
            className="flex justify-between gap-2 px-4 py-3 text-sm"
            data-testid="labour-row"
            data-part={r.part}
          >
            <span className="min-w-0">
              <span className="block font-medium">
                {r.part === 'other' ? 'Other departments' : r.name.split(' – ').pop()}
              </span>
              <span className="block text-xs text-slate-500">
                {formatMeasure('hours', r.hours)}
                {Number(r.overtime_hours) > 0 &&
                  ` · ${formatMeasure('hours', r.overtime_hours)} overtime`}
                {r.part === 'department' &&
                  r.days < whole.days &&
                  ` · ${r.days} of ${whole.days} days`}
              </span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums">
              {formatMeasure('money', r.cost)}
            </span>
          </li>
        ))}
        <li
          className="flex justify-between gap-2 bg-slate-50 px-4 py-3 text-sm font-semibold"
          data-testid="labour-total"
        >
          <span>
            Whole place
            <span className="block text-xs font-normal text-slate-500">
              {formatMeasure('hours', whole.hours)} · {formatMeasure('money', whole.hourly_cost)}{' '}
              hourly, {formatMeasure('money', whole.salary_cost)} salaried
            </span>
          </span>
          <span className="tabular-nums">{formatMeasure('money', whole.cost)}</span>
        </li>
      </ul>
      <p className="text-xs text-slate-500">
        A department with fewer than 3 paid people that day is counted in Other departments, so no
        one&apos;s pay can be worked out.
      </p>
    </section>
  );
}
