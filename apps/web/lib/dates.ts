// Calendar helpers for the people screens. Dates are node-local 'YYYY-MM-DD' strings
// (shifts, leave, weeks); instants are shown in the node's IANA timezone. Pure functions,
// usable on the server and in client components.

export const DEFAULT_TZ = 'Asia/Kolkata';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today's date in `tz`. */
export function localToday(tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday, 1 = Monday. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** Inclusive calendar days between two dates (leave counting, ADR 008). */
export function daysInclusive(from: string, to: string): number {
  const ms = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/** 'Mon 5 Oct' */
export function formatDay(date: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

/** '09:30' in `tz` */
export function formatTime(at: Date | string, tz: string = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  }).format(new Date(at));
}

/** '09:00–17:00' (end on the next day gets a '+1') */
export function formatSpan(start: Date | string, end: Date | string, tz: string = DEFAULT_TZ) {
  const nextDay = localDate(end, tz) !== localDate(start, tz);
  return `${formatTime(start, tz)}–${formatTime(end, tz)}${nextDay ? ' +1' : ''}`;
}

/** The date an instant falls on in `tz`. */
export function localDate(at: Date | string, tz: string = DEFAULT_TZ): string {
  return localToday(tz, new Date(at));
}

/** Hours between two instants, one decimal. */
export function hoursBetween(start: Date | string, end: Date | string): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 360_000) / 10;
}

/** A local date and 'HH:MM' in `tz` as an ISO instant (for event times entered locally). */
export function localToInstant(date: string, time: string, tz: string = DEFAULT_TZ): string {
  // Start from the wall-clock time as if it were UTC, then correct by the zone's offset
  // at that moment (twice, to settle across a DST change; India has none).
  const wall = new Date(`${date}T${time}:00Z`).getTime();
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const shown = new Date(guess);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(shown);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    const asUtc = Date.parse(
      `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00Z`,
    );
    guess += wall - asUtc;
  }
  return new Date(guess).toISOString();
}

/** 'Friday, 2 October' for the day `at` falls on in `tz`. */
export function formatLongDay(at: Date | string, tz: string = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: tz,
  }).format(new Date(at));
}
