// How a regular compliance job repeats (ADR 116): every N months (as before), every week or
// every 2 weeks on a weekday, or on the nth weekday of each month ("2nd Tuesday", "last
// Friday"). The database works out the next due date (ops.compliance_next); this is the one
// place that reads a rule from words (file 39 `repeat`) and says it back in words.

export const EVERY_MONTHS = [1, 2, 3, 4, 6, 12, 24, 36] as const;

/** ISO weekdays: 1 Monday … 7 Sunday. */
export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** 1st to 4th, or -1 for the last one in the month. */
export const NTHS = [1, 2, 3, 4, -1] as const;

export type Repeat =
  | { kind: 'months'; months: number }
  | { kind: 'weeks'; weeks: 1 | 2; weekday: number }
  | { kind: 'nth'; nth: number; weekday: number };

/** The columns of ops.compliance_item a rule is stored in. */
export interface RepeatColumns {
  every_months: number | null;
  every_weeks: number | null;
  nth: number | null;
  on_weekday: number | null;
}

export function repeatColumns(r: Repeat): RepeatColumns {
  if (r.kind === 'months') {
    return { every_months: r.months, every_weeks: null, nth: null, on_weekday: null };
  }
  if (r.kind === 'weeks') {
    return { every_months: null, every_weeks: r.weeks, nth: null, on_weekday: r.weekday };
  }
  return { every_months: null, every_weeks: null, nth: r.nth, on_weekday: r.weekday };
}

/** A rule from its columns; a row with none is read as every month. */
export function repeatOf(c: Partial<RepeatColumns>): Repeat {
  if (c.every_weeks && c.on_weekday) {
    return { kind: 'weeks', weeks: c.every_weeks === 2 ? 2 : 1, weekday: c.on_weekday };
  }
  if (c.nth && c.on_weekday) return { kind: 'nth', nth: c.nth, weekday: c.on_weekday };
  return { kind: 'months', months: c.every_months ?? 1 };
}

const ORDINAL: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', [-1]: 'Last' };

export function nthWords(nth: number): string {
  return ORDINAL[nth] ?? `${nth}th`;
}

function weekday(n: number): string {
  return WEEKDAYS[n - 1] ?? 'Monday';
}

/** "Every 6 months", "Every week on Monday", "2nd Tuesday of each month". */
export function repeatWords(r: Repeat): string {
  if (r.kind === 'weeks') {
    return `${r.weeks === 2 ? 'Every 2 weeks' : 'Every week'} on ${weekday(r.weekday)}`;
  }
  if (r.kind === 'nth') return `${nthWords(r.nth)} ${weekday(r.weekday)} of each month`;
  const m = r.months;
  if (m === 1) return 'Every month';
  if (m === 12) return 'Every year';
  if (m % 12 === 0) return `Every ${m / 12} years`;
  return `Every ${m} months`;
}

const DAY = new RegExp(`^(${WEEKDAYS.join('|')})$`, 'i');

function dayNumber(word: string): number | null {
  const m = DAY.exec(word.trim());
  if (!m) return null;
  return WEEKDAYS.findIndex((d) => d.toLowerCase() === m[1]!.toLowerCase()) + 1;
}

/**
 * A rule from words, as file 39's `repeat` column takes it: "every week on Monday", "every 2
 * weeks on Monday", "2nd Tuesday", "last Friday" (of each month may follow). Null when it is
 * none of these.
 */
export function parseRepeat(text: string): Repeat | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/ of (each|every) month$/, '');
  let m = /^every (week|2 weeks|other week|fortnight) on (\w+)$/.exec(t);
  if (m) {
    const day = dayNumber(m[2]!);
    if (!day) return null;
    return { kind: 'weeks', weeks: m[1] === 'week' ? 1 : 2, weekday: day };
  }
  m = /^(1st|2nd|3rd|4th|last|first|second|third|fourth) (\w+)$/.exec(t);
  if (m) {
    const day = dayNumber(m[2]!);
    if (!day) return null;
    const nth: Record<string, number> = {
      '1st': 1,
      first: 1,
      '2nd': 2,
      second: 2,
      '3rd': 3,
      third: 3,
      '4th': 4,
      fourth: 4,
      last: -1,
    };
    return { kind: 'nth', nth: nth[m[1]!]!, weekday: day };
  }
  return null;
}
