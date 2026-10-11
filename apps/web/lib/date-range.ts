import { addDays, daysInclusive, isIsoDate } from './dates';

// A list's days (ADR 120): from one day to another, both kept, chosen on the calendar or with a
// quick chip, never only "7 or 30 days". Pure: the page reads it from its URL (?from=&to=) and
// the list's CSV download reads the same.

export interface DateRange {
  from: string;
  to: string;
}

export interface QuickRange {
  key: string;
  label: string;
  range: DateRange;
}

/**
 * The days asked for, made sensible: the last `days` days to `today` when nothing is asked; a
 * day after today is today (nothing has happened yet); from after to swaps them; at most
 * `maxDays` days, the earliest left out.
 */
export function readRange(
  asked: { from?: string | undefined; to?: string | undefined },
  today: string,
  days = 7,
  maxDays = 366,
): DateRange {
  let to = asked.to && isIsoDate(asked.to) ? asked.to : today;
  if (to > today) to = today;
  let from = asked.from && isIsoDate(asked.from) ? asked.from : addDays(to, 1 - days);
  if (from > today) from = today;
  if (from > to) [from, to] = [to, from];
  if (daysInclusive(from, to) > maxDays) from = addDays(to, 1 - maxDays);
  return { from, to };
}

/** The quick chips: today, the last 7 and 30 days, this month so far. */
export function quickRanges(today: string): QuickRange[] {
  return [
    { key: 'today', label: 'Today', range: { from: today, to: today } },
    { key: '7', label: '7 days', range: { from: addDays(today, -6), to: today } },
    { key: '30', label: '30 days', range: { from: addDays(today, -29), to: today } },
    { key: 'month', label: 'This month', range: { from: `${today.slice(0, 8)}01`, to: today } },
  ];
}

/** A URL's query with the range in it and the other parameters kept. */
export function rangeQuery(params: Record<string, string | undefined>, r: DateRange): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && k !== 'from' && k !== 'to') q.set(k, v);
  }
  q.set('from', r.from);
  q.set('to', r.to);
  return q.toString();
}
