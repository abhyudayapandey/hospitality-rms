import Link from 'next/link';
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
