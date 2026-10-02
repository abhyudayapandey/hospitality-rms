import { DEFAULT_TZ, localDate, localToday } from './dates';

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

export type Schedule =
  | { kind: 'daily'; times: string[] }
  | { kind: 'weekly'; weekdays: number[]; times: string[] }
  | { kind: 'every_n_hours'; every: number; from: string; to: string };

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
  }
}

export interface StepInput {
  label: string;
  kind: 'tick' | 'number' | 'text' | 'photo';
  min?: number | null;
  max?: number | null;
  unit?: string | null;
  photo_required?: boolean;
}

/**
 * Steps from the editor's text box, one per line:
 *   "Wipe the shelves"                     a tick
 *   "Fridge 1 temperature | 0-5 °C"        a number with its acceptable range and unit
 *   "Notes | text", "Shelf photo | photo", "Floor | photo required"
 */
export function parseSteps(text: string): StepInput[] | string {
  const steps: StepInput[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const [label = '', spec = ''] = line.split('|').map((x) => x.trim());
    if (!label) return `Line ${i + 1}: the step needs a name.`;
    const s = spec.toLowerCase();
    if (!s) steps.push({ label, kind: 'tick' });
    else if (s === 'text') steps.push({ label, kind: 'text' });
    else if (s === 'photo') steps.push({ label, kind: 'photo' });
    else if (s === 'photo required' || s === 'tick, photo')
      steps.push({ label, kind: 'tick', photo_required: true });
    else {
      const m = /^(-?\d+(?:\.\d+)?)?\s*(?:-|to)\s*(-?\d+(?:\.\d+)?)?\s*(.*)$/.exec(spec);
      if (!m || (m[1] === undefined && m[2] === undefined)) {
        if (s === 'number') {
          steps.push({ label, kind: 'number' });
          continue;
        }
        return `Line ${i + 1}: after | write text, photo, photo required, number or a range like 0-5 °C.`;
      }
      const min = m[1] === undefined ? null : Number(m[1]);
      const max = m[2] === undefined ? null : Number(m[2]);
      if (min !== null && max !== null && min > max) {
        return `Line ${i + 1}: the lowest acceptable value is above the highest.`;
      }
      steps.push({ label, kind: 'number', min, max, unit: m[3]?.trim() || null });
    }
  }
  if (steps.length > 30) return 'Up to 30 steps.';
  return steps;
}

/** The editor's text for existing steps (the reverse of parseSteps). */
export function stepsText(steps: readonly StepInput[]): string {
  return steps
    .map((s) => {
      if (s.kind === 'text') return `${s.label} | text`;
      if (s.kind === 'photo') return `${s.label} | photo`;
      if (s.kind === 'number') {
        if (s.min == null && s.max == null) return `${s.label} | number`;
        const unit = s.unit ? ` ${s.unit}` : '';
        return `${s.label} | ${s.min ?? ''}-${s.max ?? ''}${unit}`;
      }
      return s.photo_required ? `${s.label} | photo required` : s.label;
    })
    .join('\n');
}

/** Whether a reading is outside its acceptable range (the server decides; this warns). */
export function outOfRange(v: number, min?: number | null, max?: number | null): boolean {
  return (min != null && v < min) || (max != null && v > max);
}

/** "3 of 5" and a percentage for completion bars. */
export function progress(done: number, total: number): { text: string; pct: number } {
  return { text: `${done} of ${total}`, pct: total === 0 ? 0 : Math.round((100 * done) / total) };
}
