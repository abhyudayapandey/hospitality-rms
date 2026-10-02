// Home is "Today" (UX review U-1, UX-2): a short list of cards, each with one action.
// These helpers choose what each card shows; they are pure so they can be unit tested.

import { formatSpan, localDate } from './dates';

export interface TaskLike {
  id: string;
  title: string;
  due_at: Date | string;
  overdue: boolean;
  place_name: string;
}

/** Overdue first, then what is due today (local), oldest first; the first `max` of them. */
export function todaysTasks<T extends TaskLike>(
  tasks: readonly T[],
  now: Date,
  tz: string,
  max = 3,
): { shown: T[]; total: number } {
  const today = localDate(now, tz);
  const list = tasks
    .filter((t) => t.overdue || localDate(t.due_at, tz) <= today)
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        new Date(a.due_at).getTime() - new Date(b.due_at).getTime(),
    );
  return { shown: list.slice(0, max), total: list.length };
}

export interface ShiftLike {
  start_at: Date | string;
  end_at: Date | string;
  node_name: string;
}

/** The shift to show: the one on now, else the next that starts within 24 hours. */
export function currentShift<S extends ShiftLike>(shifts: readonly S[], now: Date): S | null {
  const t = now.getTime();
  return (
    [...shifts]
      .filter(
        (s) => new Date(s.end_at).getTime() > t && new Date(s.start_at).getTime() < t + 86_400_000,
      )
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())[0] ?? null
  );
}

/** "Today 06:00–14:00 · Kitchen", "Tomorrow 22:00–06:00 · Bar". */
export function shiftLine(s: ShiftLike, now: Date, tz: string): string {
  const day = localDate(s.start_at, tz) === localDate(now, tz) ? 'Today' : 'Tomorrow';
  return `${day} ${formatSpan(s.start_at, s.end_at, tz)} · ${s.node_name}`;
}

export interface Shortcut {
  href: string;
  label: string;
}

/** At most `max` shortcuts on the card; the rest under "All screens". Order is priority. */
export function splitShortcuts(
  all: readonly Shortcut[],
  max = 4,
): { shortcuts: Shortcut[]; rest: Shortcut[] } {
  const seen = new Set<string>();
  const unique = all.filter((s) => !seen.has(s.href) && seen.add(s.href));
  return { shortcuts: unique.slice(0, max), rest: unique.slice(max) };
}

export interface Attention {
  belowPar: number;
  flags: number;
  repairs: number;
  /** future open slots in the next seven days, at places where they build the roster */
  openSlots: number;
  /** the roster day of the first of them (UX U-27: Home → that day → Assign) */
  openSlotHref: string | null;
}

/** The "Needs attention" lines that have something in them. */
export function attentionLines(a: Attention): { href: string; text: string; n: number }[] {
  const lines = [
    {
      href: '/stock',
      n: a.belowPar,
      text: a.belowPar === 1 ? 'item below par' : 'items below par',
    },
    {
      href: '/roster/exceptions',
      n: a.flags,
      text: a.flags === 1 ? 'attendance flag' : 'attendance flags',
    },
    {
      href: '/tasks/maintenance',
      n: a.repairs,
      text: a.repairs === 1 ? 'open repair' : 'open repairs',
    },
    {
      href: a.openSlotHref ?? '/roster',
      n: a.openSlots,
      text: a.openSlots === 1 ? 'open slot this week' : 'open slots this week',
    },
  ];
  return lines.filter((l) => l.n > 0);
}
