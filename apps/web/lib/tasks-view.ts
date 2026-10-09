import { DEFAULT_TZ, localDate, localToday } from './dates';
import { formatWhen } from './format';

// Presentation helpers for tasks and checklists (ADR 020), free of server-only so unit
// tests can run them. Rules (who may do what) stay in SQL.

export interface TaskRow {
  id: string;
  title: string;
  due_at: Date | string;
  status: string;
  overdue: boolean;
}

export type TaskGroup = 'overdue' | 'today' | 'upcoming' | 'done';

export const GROUP_TITLES: Record<TaskGroup, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Coming up',
  done: 'Done',
};

/** My tasks in the order a person works through them: overdue, today, later, done. */
export function groupTasks<T extends TaskRow>(
  rows: readonly T[],
  tz: string = DEFAULT_TZ,
  now: Date = new Date(),
): Record<TaskGroup, T[]> {
  const today = localToday(tz, now);
  const out: Record<TaskGroup, T[]> = { overdue: [], today: [], upcoming: [], done: [] };
  for (const r of rows) {
    if (r.status === 'done') out.done.push(r);
    else if (r.overdue) out.overdue.push(r);
    else if (localDate(r.due_at, tz) <= today) out.today.push(r);
    else out.upcoming.push(r);
  }
  return out;
}

/**
 * Who has one of my tasks (ADR 074): "You" (and from whom, when someone gave it to me), or
 * before anyone has taken it, the job role's or the shift's.
 */
export function myTaskWho(t: {
  taken: boolean;
  assign_mode: string;
  assigned_by_name: string | null;
}): string {
  if (t.taken) return t.assigned_by_name ? `You, from ${t.assigned_by_name}` : 'You';
  return t.assign_mode === 'on_shift'
    ? 'Whoever is on shift'
    : 'Your job role: the first to start takes it';
}

/**
 * Who did a done task, and when (ADR 075): "Done by you, today, 10:42 am", or the name of
 * whoever in the job role did it. Null for a task still to do.
 */
export function doneBy(
  t: { status: string; completed_at: Date | string | null; done_by_name: string | null },
  now: Date = new Date(),
): string | null {
  if (t.status !== 'done' || !t.completed_at) return null;
  return `Done by ${t.done_by_name ?? 'you'}, ${formatWhen(t.completed_at, now)}`;
}

/**
 * Done this business day or the one before (the 04:00 day in India, as the To do list keeps
 * done tasks, ADR 075): how long a done repair stays on its technician's list.
 */
export function doneLately(at: Date | string | null, now: Date = new Date()): boolean {
  if (!at) return false;
  const day = (d: Date) => localDate(new Date(d.getTime() - 4 * 3_600_000), DEFAULT_TZ);
  const yesterday = localDate(new Date(now.getTime() - 28 * 3_600_000), DEFAULT_TZ);
  return day(new Date(at)) >= yesterday;
}

/** Who has a task on a manager's list: "You" when it is theirs, else the name or the pool. */
export function teamWho(
  t: { assignee_user_id: string | null; assignee_name: string | null; pool: string | null },
  me: string,
): string | null {
  if (t.assignee_user_id === me) return 'You';
  return t.assignee_name ?? t.pool;
}

/**
 * It was already overdue when it reached whoever has it (ADR 074): their lateness counts from
 * when they got it, not from the due date.
 */
export function overdueWhenGiven(t: {
  due_at: Date | string;
  given?: Date | string | null;
}): boolean {
  return !!t.given && new Date(t.given).getTime() > new Date(t.due_at).getTime();
}

export type Schedule =
  | { kind: 'daily'; times: string[] }
  | { kind: 'weekly'; weekdays: number[]; times: string[] }
  | { kind: 'every_n_hours'; every: number; from: string; to: string }
  | { kind: 'monthly'; days: number[]; times: string[] }
  | { kind: 'nth_weekday'; weekday: number; nths: number[]; times: string[] };

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ORDINAL = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** `Mon,Thu`, `Mon-Fri` or `on Mon, Thu` -> ISO weekdays (1 Monday); null: not weekdays. */
export function parseWeekdays(text: string): number[] | null {
  const t = text.trim().replace(/^on\s+/i, '');
  if (!t) return null;
  const set = new Set<number>();
  for (const part of t.split(',').map((x) => x.trim())) {
    const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:\s*-\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun))?$/i.exec(
      part,
    );
    if (!m) return null;
    const at = (d: string) => WEEKDAYS.findIndex((w) => w.toLowerCase() === d.toLowerCase()) + 1;
    const from = at(m[1]!);
    const to = at(m[2] ?? m[1]!);
    for (let d = from; ; d = (d % 7) + 1) {
      set.add(d);
      if (d === to) break;
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** "Mon,Thu" for the editor and the step's line. */
export function weekdaysText(days: readonly number[]): string {
  return days.map((d) => WEEKDAYS[d - 1] ?? '?').join(',');
}

/** "Daily at 07:00 and 15:00", "Mon and Thu at 09:00", "Every 2 hours, 08:00 to 22:00". */
export function describeSchedule(s: Schedule): string {
  const list = (xs: string[]) =>
    xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  switch (s.kind) {
    case 'daily':
      return `Daily at ${list(s.times)}`;
    case 'weekly':
      return `${list(s.weekdays.map((d) => WEEKDAYS[d - 1] ?? '?'))} at ${list(s.times)}`;
    case 'every_n_hours':
      return `Every ${s.every === 1 ? 'hour' : `${s.every} hours`}, ${s.from} to ${s.to}`;
    case 'monthly':
      return `On the ${list(s.days.map(ORDINAL))} of the month at ${list(s.times)}`;
    case 'nth_weekday':
      return `The ${list(s.nths.map(ORDINAL))} ${WEEKDAYS[s.weekday - 1] ?? '?'} of the month at ${list(s.times)}`;
  }
}

export interface StepInput {
  label: string;
  kind: 'tick' | 'number' | 'text' | 'photo';
  min?: number | null;
  max?: number | null;
  unit?: string | null;
  photo_required?: boolean;
  /** its picture when chosen (ADR 079); none: picked from its words */
  icon?: string | null;
  /** the weekdays it runs (1 Monday, ADR 087); none: every round */
  days?: number[] | null;
}

/**
 * Steps from the editor's text box, one per line:
 *   "Wipe the shelves"                     a tick
 *   "Fridge 1 temperature | 0-5 °C"        a number with its acceptable range and unit
 *   "Notes | text", "Shelf photo | photo", "Floor | photo required"
 *   "Clean the hoods | Mon,Thu"            only on those weekdays (ADR 087), after any kind
 */
export function parseSteps(text: string): StepInput[] | string {
  const steps: StepInput[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|').map((x) => x.trim());
    const label = parts[0] ?? '';
    if (!label) return `Line ${i + 1}: the step needs a name.`;
    // the weekdays, when the last part is them
    const days = parts.length > 1 ? parseWeekdays(parts[parts.length - 1]!) : null;
    const step = parseStep(label, (days ? parts.slice(1, -1) : parts.slice(1)).join('|'));
    if (typeof step === 'string') return `Line ${i + 1}: ${step}`;
    steps.push(days ? { ...step, days } : step);
  }
  if (steps.length > 30) return 'Up to 30 steps.';
  return steps;
}

function parseStep(label: string, spec: string): StepInput | string {
  const s = spec.toLowerCase();
  if (!s) return { label, kind: 'tick' };
  if (s === 'text') return { label, kind: 'text' };
  if (s === 'photo') return { label, kind: 'photo' };
  if (s === 'photo required' || s === 'tick, photo') {
    return { label, kind: 'tick', photo_required: true };
  }
  if (s === 'number') return { label, kind: 'number' };
  const m = /^(-?\d+(?:\.\d+)?)?\s*(?:-|to)\s*(-?\d+(?:\.\d+)?)?\s*(.*)$/.exec(spec);
  if (!m || (m[1] === undefined && m[2] === undefined)) {
    return 'after | write text, photo, photo required, number, a range like 0-5 °C or the days like Mon,Thu.';
  }
  const min = m[1] === undefined ? null : Number(m[1]);
  const max = m[2] === undefined ? null : Number(m[2]);
  if (min !== null && max !== null && min > max) {
    return 'the lowest acceptable value is above the highest.';
  }
  return { label, kind: 'number', min, max, unit: m[3]?.trim() || null };
}

/** The editor's text for existing steps (the reverse of parseSteps). */
export function stepsText(steps: readonly StepInput[]): string {
  return steps
    .map((s) => (s.days?.length ? `${stepText(s)} | ${weekdaysText(s.days)}` : stepText(s)))
    .join('\n');
}

function stepText(s: StepInput): string {
  if (s.kind === 'text') return `${s.label} | text`;
  if (s.kind === 'photo') return `${s.label} | photo`;
  if (s.kind === 'number') {
    if (s.min == null && s.max == null) return `${s.label} | number`;
    const unit = s.unit ? ` ${s.unit}` : '';
    return `${s.label} | ${s.min ?? ''}-${s.max ?? ''}${unit}`;
  }
  return s.photo_required ? `${s.label} | photo required` : s.label;
}

/** Whether a reading is outside its acceptable range (the server decides; this warns). */
export function outOfRange(v: number, min?: number | null, max?: number | null): boolean {
  return (min != null && v < min) || (max != null && v > max);
}

/** "3 of 5" and a percentage for completion bars. */
export function progress(done: number, total: number): { text: string; pct: number } {
  return { text: `${done} of ${total}`, pct: total === 0 ? 0 : Math.round((100 * done) / total) };
}
