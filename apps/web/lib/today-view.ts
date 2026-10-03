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

export type AttentionKind = 'lowStock' | 'flags' | 'repairs' | 'openSlots';

/** One count at one place: a store (low stock) or an org place (the rest). */
export interface AttentionCount {
  kind: AttentionKind;
  node: string;
  n: number;
  /** open slots: the roster day of the first of them there (UX U-27) */
  href?: string | null;
}

/** core.department_of: a place's department and its place in the order (DB-2, ADR 033). */
export interface PlaceDepartment {
  node_id: string;
  department_id: string | null;
  department: string | null;
  /** 1 kitchen, 2 service, 3 housekeeping, 4 other, 5 no department (the outlet itself) */
  rank: number;
  outlet_id: string | null;
  outlet: string | null;
}

export interface AttentionLine {
  kind: AttentionKind;
  href: string;
  text: string;
  n: number;
}

/** red: something runs out or is broken now; amber: needs doing soon (UX-6) */
export type AttentionTone = 'bad' | 'warn';

export interface AttentionGroup {
  key: string;
  label: string;
  lines: AttentionLine[];
  /** everything in the group added up */
  total: number;
  tone: AttentionTone;
}

const KINDS: readonly AttentionKind[] = ['lowStock', 'flags', 'repairs', 'openSlots'];

/** Low stock runs out within three days: red. The rest wait a little: amber. */
const TONE: Record<AttentionKind, AttentionTone> = {
  lowStock: 'bad',
  repairs: 'warn',
  flags: 'warn',
  openSlots: 'warn',
};

const LINE: Record<AttentionKind, { href: string; one: string; many: string }> = {
  lowStock: { href: '/stock?low=1', one: 'item running low', many: 'items running low' },
  flags: { href: '/roster/exceptions', one: 'attendance issue', many: 'attendance issues' },
  repairs: { href: '/tasks/maintenance', one: 'open repair', many: 'open repairs' },
  openSlots: { href: '/roster', one: 'open shift this week', many: 'open shifts this week' },
};

/**
 * "Needs attention" by department (DB-2): Kitchen first, then Service, then Housekeeping,
 * then the rest; what belongs to no department (the outlet itself) last. Within one outlet
 * the outlet's name is left off the department ("Kitchen"); across outlets it stays.
 */
export function attentionGroups(
  counts: readonly AttentionCount[],
  places: readonly PlaceDepartment[],
): AttentionGroup[] {
  const of = new Map(places.map((p) => [p.node_id, p]));
  const groups = new Map<
    string,
    { place: PlaceDepartment | undefined; n: Map<AttentionKind, number>; slot: string | null }
  >();
  for (const c of counts) {
    if (c.n <= 0) continue;
    const p = of.get(c.node);
    const key = p?.department_id ?? `outlet:${p?.outlet_id ?? ''}`;
    const g = groups.get(key) ?? { place: p, n: new Map<AttentionKind, number>(), slot: null };
    g.n.set(c.kind, (g.n.get(c.kind) ?? 0) + c.n);
    if (c.kind === 'openSlots' && !g.slot && c.href) g.slot = c.href;
    groups.set(key, g);
  }
  const outlets = new Set([...groups.values()].map((g) => g.place?.outlet_id ?? ''));
  const oneOutlet = outlets.size === 1;
  const label = (p: PlaceDepartment | undefined) => {
    if (!p?.department) return oneOutlet ? 'Whole outlet' : (p?.outlet ?? 'Other places');
    const prefix = `${p.outlet} – `;
    return oneOutlet && p.outlet && p.department.startsWith(prefix)
      ? p.department.slice(prefix.length)
      : p.department;
  };
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      rank: g.place?.rank ?? 5,
      outlet: g.place?.outlet ?? '',
      label: label(g.place),
      lines: KINDS.filter((k) => (g.n.get(k) ?? 0) > 0).map((k) => {
        const n = g.n.get(k)!;
        return {
          kind: k,
          href: k === 'openSlots' ? (g.slot ?? LINE[k].href) : LINE[k].href,
          n,
          text: n === 1 ? LINE[k].one : LINE[k].many,
        };
      }),
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank || a.outlet.localeCompare(b.outlet) || a.label.localeCompare(b.label),
    )
    .map(({ key, label: l, lines }) => ({
      key,
      label: l,
      lines,
      total: lines.reduce((t, x) => t + x.n, 0),
      tone: lines.some((x) => TONE[x.kind] === 'bad') ? ('bad' as const) : ('warn' as const),
    }));
}
