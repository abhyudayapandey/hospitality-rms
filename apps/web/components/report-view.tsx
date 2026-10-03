import Link from 'next/link';
import { addDays, formatDay } from '@/lib/dates';
import {
  compare,
  costParts,
  formatMeasure,
  PERIODS,
  REPORTS,
  sectionRows,
  SECTIONS,
  type CostPartRow,
  type MeasureRow,
  type Period,
  type ReportCode,
} from '@/lib/reports';
import { vsTarget, type TargetKey } from '@/lib/settings';
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

/**
 * A report's figures in its sections; each against the same day last week when there is one,
 * and against the company's target (R-4): red only when worse by more than 2 points.
 */
export function ReportSections({
  report,
  rows,
  targets,
}: {
  report: ReportCode;
  rows: MeasureRow[];
  targets?: Record<TargetKey, number> | undefined;
}) {
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
                const t = targets ? vsTarget(r.measure, r.value, targets) : null;
                return (
                  <li
                    key={r.measure}
                    className="flex items-baseline justify-between gap-3 p-3"
                    data-testid={`measure-${r.measure}`}
                    data-target={t?.state ?? 'none'}
                  >
                    <span className="text-sm text-slate-700">{r.def.label}</span>
                    <span className="text-right">
                      <span
                        className={`block font-semibold tabular-nums ${t?.state === 'bad' ? 'text-rose-700' : ''}`}
                        data-testid="value"
                      >
                        {formatMeasure(r.def.unit, r.value)}
                      </span>
                      {t?.target !== null && t?.target !== undefined && (
                        <span
                          className={`block text-xs ${t.state === 'bad' ? 'text-rose-700' : 'text-slate-500'}`}
                          data-testid="target"
                        >
                          target {formatMeasure('pct', t.target)}
                        </span>
                      )}
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

/**
 * Yesterday / last 7 days / this month as links, and two dates for any other period
 * (the cost controller's reports, ADR 028). Business days at the place.
 */
export function PeriodPicker({
  action,
  node,
  period,
  from,
  to,
}: {
  action: string;
  node: string;
  period: Period;
  from: string;
  to: string;
}) {
  const chip = (on: boolean) =>
    `flex min-h-11 items-center rounded-full px-4 text-sm whitespace-nowrap ${
      on ? 'bg-brand-700 font-semibold text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300'
    }`;
  return (
    <div className="space-y-2" data-testid="period">
      <nav aria-label="Period" className="-mx-4 flex gap-2 overflow-x-auto px-4">
        {PERIODS.filter((p) => p.code !== 'custom').map((p) => (
          <Link
            key={p.code}
            href={`${action}?node=${node}&period=${p.code}`}
            aria-current={p.code === period ? 'page' : undefined}
            className={chip(p.code === period)}
          >
            {p.label}
          </Link>
        ))}
      </nav>
      <details open={period === 'custom'}>
        <summary className="min-h-11 cursor-pointer py-2 text-sm text-slate-700 underline">
          {period === 'custom' ? `${formatDay(from)} to ${formatDay(to)}` : 'Pick dates'}
        </summary>
        <form action={action} className="grid grid-cols-2 gap-2">
          <input type="hidden" name="node" value={node} />
          <input type="hidden" name="period" value="custom" />
          <label className="space-y-1">
            <span className="text-sm">From</span>
            <input
              type="date"
              name="from"
              defaultValue={from}
              className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm">To</span>
            <input
              type="date"
              name="to"
              defaultValue={to}
              className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3"
            />
          </label>
          <button className="col-span-2 min-h-12 rounded-lg border border-slate-300 bg-white">
            Show
          </button>
        </form>
      </details>
    </div>
  );
}

/**
 * Where the money went (R-3, ADR 030): raw materials by part, people (only for those who
 * see labour cost), and the total, each in ₹ and as a share of sales.
 */
export function CostBreakdown({ rows, note }: { rows: CostPartRow[]; note?: string }) {
  const list = costParts(rows);
  if (list.length === 0) return null;
  return (
    <section aria-label="Where the money went" className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-700">Where the money went</h2>
      <ul
        className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200"
        data-testid="cost-breakdown"
      >
        {list.map((p) => (
          <li
            key={p.part}
            data-testid={`part-${p.part}`}
            className={`flex items-baseline justify-between gap-3 py-2 pr-3 text-sm ${
              p.total ? 'bg-slate-50 pl-3 font-semibold' : 'pl-6 text-slate-700'
            }`}
          >
            <span>{p.label}</span>
            <span className="shrink-0 text-right tabular-nums">
              <span data-testid="value">{formatMeasure('money', p.value)}</span>
              <span className="ml-2 inline-block w-14 text-xs font-normal text-slate-500">
                {formatMeasure('pct', p.pct)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {note && <p className="text-xs text-slate-500">{note}</p>}
    </section>
  );
}

/**
 * Download one of the report's lists as a CSV file (R-4, ADR 031): the same figures, for the
 * same place and period. A plain link, so it works on any phone.
 */
export function CsvLink({
  report,
  node,
  period,
  label = 'Download CSV',
}: {
  report: string;
  node: string;
  period?: { period: Period; from: string; to: string } | undefined;
  label?: string;
}) {
  const q = period
    ? `node=${node}&period=${period.period}&from=${period.from}&to=${period.to}`
    : `node=${node}`;
  return (
    <a
      href={`/reports/csv/${report}?${q}`}
      className="inline-flex min-h-11 items-center text-sm text-slate-700 underline"
      data-testid={`csv-${report}`}
    >
      {label}
    </a>
  );
}
