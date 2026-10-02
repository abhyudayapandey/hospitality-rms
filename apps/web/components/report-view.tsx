import Link from 'next/link';
import { addDays, formatDay } from '@/lib/dates';
import {
  compare,
  formatMeasure,
  REPORTS,
  sectionRows,
  SECTIONS,
  type MeasureRow,
  type ReportCode,
} from '@/lib/reports';
import { PlaceSwitcher, type SwitcherPlace } from './place-switcher';
import type { ReportScreen } from '@/lib/place-screens';

/** Title, a link back to the list, and the "Place:" switcher when there is a choice. */
export function ReportHeader({
  report,
  switcher,
}: {
  report: ReportCode;
  switcher?: { screen: ReportScreen; places: SwitcherPlace[]; current: string } | undefined;
}) {
  return (
    <div className="space-y-2">
      {switcher && <PlaceSwitcher {...switcher} />}
      <Link href="/reports" className="text-sm text-slate-600 underline">
        ← Reports
      </Link>
      <h1 className="text-xl font-semibold">{REPORTS[report].title}</h1>
    </div>
  );
}

/** Previous day / the day / next day, as links (?day=), never past today. */
export function DayPicker({
  href,
  day,
  today,
}: {
  href: (day: string) => string;
  day: string;
  today: string;
}) {
  const label =
    day === today ? 'Today so far' : day === addDays(today, -1) ? 'Yesterday' : formatDay(day);
  const box = 'flex min-h-11 min-w-11 items-center justify-center rounded-lg ring-1 ring-slate-300';
  return (
    <div className="flex items-center justify-between gap-2">
      <Link href={href(addDays(day, -1))} aria-label="Day before" className={box}>
        ←
      </Link>
      <p className="text-center font-medium" data-testid="report-day">
        {label}
      </p>
      {day < today ? (
        <Link href={href(addDays(day, 1))} aria-label="Day after" className={box}>
          →
        </Link>
      ) : (
        <span className="min-w-11" />
      )}
    </div>
  );
}

const TREND = {
  good: 'text-emerald-700',
  bad: 'text-rose-700',
  same: 'text-slate-500',
  none: 'text-slate-500',
} as const;

/** A report's figures in its sections; each against the same day last week when there is one. */
export function ReportSections({ report, rows }: { report: ReportCode; rows: MeasureRow[] }) {
  return (
    <div className="space-y-4">
      {SECTIONS[report].map(([title, measures]) => {
        const list = sectionRows(rows, measures);
        if (list.length === 0) return null;
        return (
          <section key={title} aria-label={title} className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
            <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
              {list.map((r) => {
                const c = compare(r.def, r.value, r.last_week);
                return (
                  <li
                    key={r.measure}
                    className="flex items-baseline justify-between gap-3 p-3"
                    data-testid={`measure-${r.measure}`}
                  >
                    <span className="text-sm text-slate-700">{r.def.label}</span>
                    <span className="text-right">
                      <span className="block font-semibold tabular-nums" data-testid="value">
                        {formatMeasure(r.def.unit, r.value)}
                      </span>
                      {c.text && (
                        <span className={`block text-xs ${TREND[c.trend]}`}>{c.text}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function NoReport({ children }: { children: React.ReactNode }) {
  return <p className="text-slate-600">{children}</p>;
}

export type { SwitcherPlace };
