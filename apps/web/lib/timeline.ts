import { addDays, formatTime, localDate } from './dates';
import { humanizeCode, type TitleOf } from './job-roles';

// My shifts and Clock (ADR 018): rows of hr.my_timeline, where punches are matched to
// shifts and extra time is split out by the database (one rule for staff, managers and the
// nightly job). These helpers only put the rows into words.

export type TimelineKind = 'shift' | 'extra_before' | 'extra_after' | 'unrostered';
export type TimelineStatus =
  | 'upcoming'
  | 'due'
  | 'in_progress'
  | 'clocked_out'
  | 'on_time'
  | 'late'
  | 'left_early'
  | 'no_show'
  | 'missing_clock_out'
  | 'unrostered';

export interface TimelineRow {
  local_date: string;
  kind: TimelineKind;
  shift_id: string | null;
  shift_start: string | null;
  shift_end: string | null;
  from_at: string | null;
  to_at: string | null;
  minutes: number;
  status: TimelineStatus | null;
  late_min: number | null;
  early_min: number | null;
  role_code: string | null;
  place_name: string | null;
}

/** 134 -> "2 h 14 m", 45 -> "45 m", 480 -> "8 h". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.max(0, Math.round(minutes - h * 60));
  if (h === 0) return `${m} m`;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

const jobName: TitleOf = (code) => (code ? humanizeCode(code) : '');

/** "07:00–15:00 · Server": the job by its title, never its code (UX-9). */
export function rowTitle(r: TimelineRow, tz: string, titleOf: TitleOf = jobName): string {
  switch (r.kind) {
    case 'extra_before':
      return 'Extra before shift';
    case 'extra_after':
      return 'Extra after shift';
    case 'unrostered':
      return 'Unrostered';
    default:
      return `${formatTime(r.shift_start!, tz)}–${formatTime(r.shift_end!, tz)}${
        r.role_code ? ` · ${titleOf(r.role_code)}` : ''
      }`;
  }
}

/** "ends 01:00 next day" for a shift that runs past midnight; null otherwise (replaces "+1"). */
export function endsNextDay(r: TimelineRow, tz: string): string | null {
  if (r.kind !== 'shift' || !r.shift_start || !r.shift_end) return null;
  return localDate(r.shift_end, tz) !== localDate(r.shift_start, tz)
    ? `ends ${formatTime(r.shift_end, tz)} next day`
    : null;
}

export interface WeekCell {
  date: string;
  /** "Mon" */
  day: string;
  /** when the first shift starts ("17:00"), or null for a day off */
  start: string | null;
  today: boolean;
}

/** The next seven days, one cell each: the shift's start time, or off (UX-9). */
export function weekStrip(rows: readonly TimelineRow[], today: string, tz: string): WeekCell[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i);
    const first = rows
      .filter((r) => r.kind === 'shift' && r.local_date === date && r.shift_start)
      .sort((a, b) => a.shift_start!.localeCompare(b.shift_start!))[0];
    return {
      date,
      day: new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(
        new Date(`${date}T12:00:00Z`),
      ),
      start: first ? formatTime(first.shift_start!, tz) : null,
      today: i === 0,
    };
  });
}

/** The first shift still to come (not yet worked): what a server opens My shifts to see. */
export function nextShift(rows: readonly TimelineRow[], today: string): TimelineRow | null {
  return (
    rows.find(
      (r) =>
        r.kind === 'shift' &&
        r.local_date >= today &&
        (r.status === 'upcoming' || r.status === 'due'),
    ) ?? null
  );
}

/** "In 07:45 · Out 20:10", "In 07:58 · still in", or null when nothing was worked. */
export function inOutLabel(r: TimelineRow, tz: string): string | null {
  if (!r.from_at) return null;
  const out = r.to_at ? `Out ${formatTime(r.to_at, tz)}` : 'still in';
  return `In ${formatTime(r.from_at, tz)} · ${out}`;
}

const WORDS: Record<TimelineStatus, string | null> = {
  upcoming: null,
  due: 'Not clocked in',
  in_progress: 'Clocked in',
  clocked_out: 'Clocked out',
  on_time: 'On time',
  late: 'Late',
  left_early: 'Left early',
  no_show: 'No-show',
  missing_clock_out: 'Missing clock-out',
  unrostered: 'Not rostered',
};

export function statusLabel(r: TimelineRow): string | null {
  if (!r.status) return null;
  const late = r.late_min !== null ? `Late ${formatDuration(r.late_min)}` : null;
  const early = r.early_min !== null ? `left ${formatDuration(r.early_min)} early` : null;
  if (r.status === 'late' || r.status === 'left_early') {
    const parts = [late, early].filter((x): x is string => x !== null);
    const text = parts.join(' · ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return WORDS[r.status];
}

/** Rows that need attention are shown in amber. */
export function isFlagged(r: TimelineRow): boolean {
  return (
    r.status === 'late' ||
    r.status === 'left_early' ||
    r.status === 'no_show' ||
    r.status === 'missing_clock_out'
  );
}
