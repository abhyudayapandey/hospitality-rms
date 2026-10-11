import Link from 'next/link';
import { formatDay } from '@/lib/dates';
import { quickRanges, rangeQuery, type DateRange } from '@/lib/date-range';
import { Icon } from './icon';

/**
 * Which days a list shows (ADR 120): quick chips (today, 7 and 30 days, this month) and any two
 * days on the calendar, then "Show". Plain links and a GET form, so it works before the page's
 * script has loaded; the page's other parameters are kept.
 */
export function DateRangePicker({
  path,
  params,
  range,
  today,
}: {
  path: string;
  params: Record<string, string | undefined>;
  range: DateRange;
  today: string;
}) {
  const quick = quickRanges(today);
  const on = quick.find((q) => q.range.from === range.from && q.range.to === range.to);
  return (
    <div className="space-y-2" data-testid="date-range">
      <nav aria-label="Days" className="flex flex-wrap gap-2">
        {quick.map((q) => (
          <Link
            key={q.key}
            href={`${path}?${rangeQuery(params, q.range)}`}
            aria-current={on?.key === q.key ? 'true' : undefined}
            className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm ring-1 ${
              on?.key === q.key
                ? 'bg-brand-700 font-semibold text-white ring-brand-700'
                : 'bg-white text-slate-800 ring-slate-300'
            }`}
          >
            {q.label}
          </Link>
        ))}
      </nav>
      <form method="get" action={path} className="flex flex-wrap items-end gap-2">
        {Object.entries(params).map(([k, v]) =>
          v !== undefined && v !== '' && k !== 'from' && k !== 'to' ? (
            <input key={k} type="hidden" name={k} value={v} />
          ) : null,
        )}
        <label className="flex flex-1 flex-col text-xs text-slate-600">
          From
          <input
            type="date"
            name="from"
            defaultValue={range.from}
            max={today}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-2 text-base text-slate-900"
          />
        </label>
        <label className="flex flex-1 flex-col text-xs text-slate-600">
          To
          <input
            type="date"
            name="to"
            defaultValue={range.to}
            max={today}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-2 text-base text-slate-900"
          />
        </label>
        <button
          type="submit"
          className="inline-flex min-h-11 items-center gap-1 rounded-xl px-4 font-semibold ring-1 ring-slate-300"
        >
          <Icon name="calendar" className="size-4" />
          Show
        </button>
      </form>
    </div>
  );
}

/** The list as a spreadsheet (ADR 120): the same rows the screen shows, as the person. */
export function ExportLink({
  list,
  params,
  label = 'Download',
}: {
  list: string;
  params: Record<string, string | undefined>;
  label?: string;
}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return (
    <a
      href={`/export/${list}?${q.toString()}`}
      className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-slate-700 underline"
      data-testid={`export-${list}`}
    >
      <Icon name="down" className="size-4" />
      {label}
    </a>
  );
}

/**
 * A long list's days and its download (ADR 120): folded to "Pick dates" until days are chosen,
 * then "1 Oct to 10 Oct" with "All dates" to go back to the whole list. The download holds the
 * list as it is shown: its tab, its place and its days.
 */
export function ListDays({
  path,
  params,
  range,
  today,
  list,
}: {
  path: string;
  params: Record<string, string | undefined>;
  range: DateRange | null;
  today: string;
  /** the export's name in lib/exports.ts */
  list?: string;
}) {
  const kept = Object.fromEntries(
    Object.entries(params).filter(([k]) => k !== 'from' && k !== 'to' && k !== 'n'),
  );
  const clear = new URLSearchParams(
    Object.entries(kept).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  return (
    <div className="space-y-2" data-testid="list-days">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <details open={range !== null} className="min-w-0 flex-1">
          <summary className="inline-flex min-h-11 cursor-pointer items-center gap-1 text-sm text-slate-700 underline">
            <Icon name="calendar" className="size-4" />
            {range
              ? range.from === range.to
                ? formatDay(range.from)
                : `${formatDay(range.from)} to ${formatDay(range.to)}`
              : 'Pick dates'}
          </summary>
          <div className="mt-2 space-y-2">
            <DateRangePicker
              path={path}
              params={kept}
              range={range ?? { from: today, to: today }}
              today={today}
            />
            {range && (
              <Link
                href={`${path}${clear ? `?${clear}` : ''}`}
                className="inline-flex min-h-11 items-center text-sm text-slate-700 underline"
                data-testid="all-dates"
              >
                All dates
              </Link>
            )}
          </div>
        </details>
        {list && (
          <ExportLink
            list={list}
            params={{ ...kept, ...(range ? { from: range.from, to: range.to } : {}) }}
          />
        )}
      </div>
    </div>
  );
}
