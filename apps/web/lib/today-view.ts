// Home is "Today" (UX review U-1, UX-2): a short list of cards, each with one action.
// These helpers choose what each card shows; they are pure so they can be unit tested.

import { daysWords } from '@outlet-ops/domain';
import { formatSpan, localDate } from './dates';
import { listHref, stockHref } from './stock-view';

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

// Every count that spans places opens its screen on the matching tab with "All ..." chosen
// (ADR 038, 048): one screen per function, narrowed from its own Place picker.
const LINE: Record<AttentionKind, { href: string; one: string; many: string }> = {
  lowStock: {
    href: stockHref({ tab: 'low', all: true }),
    one: 'item running low',
    many: 'items running low',
  },
  flags: {
    href: listHref('/roster/exceptions', { all: true }),
    one: 'attendance issue',
    many: 'attendance issues',
  },
  repairs: {
    href: listHref('/tasks/maintenance', { all: true, tab: 'assign' }),
    one: 'open repair',
    many: 'open repairs',
  },
  openSlots: {
    href: listHref('/roster/week', { all: true }),
    one: 'open shift this week',
    many: 'open shifts this week',
  },
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
    {
      place: PlaceDepartment | undefined;
      n: Map<AttentionKind, number>;
      slot: string | null;
      stores: Set<string>;
    }
  >();
  for (const c of counts) {
    if (c.n <= 0) continue;
    const p = of.get(c.node);
    const key = p?.department_id ?? `outlet:${p?.outlet_id ?? ''}`;
    const g = groups.get(key) ?? {
      place: p,
      n: new Map<AttentionKind, number>(),
      slot: null,
      stores: new Set<string>(),
    };
    g.n.set(c.kind, (g.n.get(c.kind) ?? 0) + c.n);
    if (c.kind === 'openSlots' && !g.slot && c.href) g.slot = c.href;
    if (c.kind === 'lowStock') g.stores.add(c.node);
    groups.set(key, g);
  }
  // A department's line opens that department, not every place (ADR 048): exceptions and
  // repairs there, low stock at its store; what is at the outlet itself opens the outlet.
  const hrefOf = (
    k: AttentionKind,
    g: { place: PlaceDepartment | undefined; slot: string | null; stores: Set<string> },
  ) => {
    const dept = g.place?.department_id ?? null;
    const scope = dept ?? g.place?.outlet_id ?? null;
    switch (k) {
      case 'openSlots':
        return g.slot ?? LINE[k].href;
      case 'lowStock':
        return g.stores.size === 1
          ? stockHref({ tab: 'low', node: [...g.stores][0]! })
          : LINE[k].href;
      case 'flags':
        return dept ? listHref('/roster/exceptions', { node: dept }) : LINE[k].href;
      case 'repairs':
        return scope
          ? listHref('/tasks/maintenance', { node: scope, tab: 'assign' })
          : LINE[k].href;
    }
  };
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
          href: hrefOf(k, g),
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

/** Clock in is offered from this long before a shift starts (UX-9). */
export const CLOCK_IN_AHEAD_MS = 2 * 3_600_000;

/** A shift that is on now or starts within two hours: the only time Home offers Clock in. */
export function clockable(s: ShiftLike, now: Date): boolean {
  const t = now.getTime();
  return (
    new Date(s.end_at).getTime() > t && new Date(s.start_at).getTime() <= t + CLOCK_IN_AHEAD_MS
  );
}

export interface DoFirstItem {
  key: string;
  tone: AttentionTone;
  n: number;
  /** "5 items running low" */
  text: string;
  /** one action, one tap */
  action: string;
  href: string;
}

/** Most things Home puts first: more is a wall, and a wall is not read (UX-8). */
export const DO_FIRST_MAX = 5;

/**
 * "Do these first": one ranked list for a manager, in place of every department's counts.
 * Counts are added up over the departments; each line opens the screen that fixes it. What is
 * waiting for the person's yes is its own card below, with Approve and No on it, and expired
 * stock is the banner above, so neither is repeated here. Red before amber, then the order
 * the jobs matter in.
 */
export function doFirst(
  input: {
    attention: readonly AttentionGroup[] | null;
    overdueTasks: number;
    /** expired batches waiting to be given to someone (repairs are the "open repairs" line) */
    toAssign: number;
    /** the roster, all departments, on the earliest day with an open slot */
    openSlotsHref?: string | null;
    /** they may ask for or order supplies somewhere; else running low is only to see (ADR 052) */
    canOrder?: boolean;
  },
  max = DO_FIRST_MAX,
): DoFirstItem[] {
  const sum = (kind: AttentionKind) =>
    (input.attention ?? []).reduce(
      (t, g) => t + g.lines.filter((l) => l.kind === kind).reduce((a, l) => a + l.n, 0),
      0,
    );
  const slotHref = input.openSlotsHref ?? LINE.openSlots.href;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const all: DoFirstItem[] = [
    {
      key: 'lowStock',
      tone: 'bad',
      n: sum('lowStock'),
      text: '',
      action: input.canOrder === false ? 'See' : 'Order',
      href: LINE.lowStock.href,
    },
    {
      key: 'overdue',
      tone: 'bad',
      n: input.overdueTasks,
      text: plural(input.overdueTasks, 'task is late', 'tasks are late'),
      action: 'Open tasks',
      href: '/tasks',
    },
    {
      key: 'openSlots',
      tone: 'warn',
      n: sum('openSlots'),
      text: '',
      action: 'Fill',
      href: slotHref,
    },
    {
      key: 'flags',
      tone: 'warn',
      n: sum('flags'),
      text: '',
      action: 'Review',
      href: LINE.flags.href,
    },
    {
      key: 'repairs',
      tone: 'warn',
      n: sum('repairs'),
      text: '',
      action: 'Assign',
      href: LINE.repairs.href,
    },
    {
      key: 'toAssign',
      tone: 'warn',
      n: input.toAssign,
      text: plural(input.toAssign, 'expired item to assign', 'expired items to assign'),
      action: 'Assign',
      href: '/inbox',
    },
  ];
  return all
    .filter((x) => x.n > 0)
    .map((x) => {
      const line = LINE[x.key as AttentionKind];
      return { ...x, text: x.text || (x.n === 1 ? line.one : line.many) };
    })
    .slice(0, max);
}

/** A row of Home's Compliance card: a licence or calendar job that needs action (ADR 069). */
export interface ComplianceRow {
  kind: 'licence' | 'job';
  id: string;
  task_id: string | null;
  place_name: string;
  name: string;
  days_left: number;
  /** not theirs to keep: the reminder is with them, so it opens their To do item */
  own: boolean;
}

export interface ComplianceInput {
  /** they see Compliance (keepers, area, owner); else only their own reminders */
  keeps: boolean;
  /** licences and calendar jobs recorded where they see them */
  recorded: number;
  rows: readonly ComplianceRow[];
}

export const COMPLIANCE_CARD_ROWS = 5;

/**
 * Home's Compliance card, above everything else (ADR 069 addendum): a lapsed licence or a
 * missed inspection can close the outlet. Red for expired and overdue, amber for what is
 * coming (licences within 90 days, jobs within 14). With nothing to do, a keeper gets one
 * green line; someone with only their own reminders gets nothing.
 */
export function complianceCard(c: ComplianceInput | null): {
  tone: 'bad' | 'warn' | 'ok' | 'empty';
  title: string;
  href: string;
  rows: {
    key: string;
    tone: 'bad' | 'warn';
    name: string;
    place: string;
    when: string;
    href: string;
  }[];
  more: number;
} | null {
  if (!c) return null;
  const all = listHref('/compliance', { all: true });
  if (c.rows.length === 0) {
    if (!c.keeps) return null;
    return c.recorded === 0
      ? { tone: 'empty', title: 'No licences recorded yet', href: all, rows: [], more: 0 }
      : {
          tone: 'ok',
          title: 'All licences valid, nothing overdue',
          href: all,
          rows: [],
          more: 0,
        };
  }
  const bad = c.rows.filter((r) => r.days_left < 0).length;
  const rows = c.rows.slice(0, COMPLIANCE_CARD_ROWS).map((r) => ({
    key: `${r.kind}-${r.id}`,
    tone: r.days_left < 0 ? ('bad' as const) : ('warn' as const),
    name: r.name,
    place: r.place_name,
    when: daysWords(r.days_left, r.kind === 'licence' ? 'Expires' : 'Due'),
    href:
      r.own && r.task_id
        ? `/tasks/${r.task_id}`
        : r.kind === 'licence'
          ? `/compliance/licences/${r.id}`
          : `/compliance/calendar/${r.id}`,
  }));
  const n = c.rows.length;
  return {
    tone: bad > 0 ? 'bad' : 'warn',
    title: `${n} ${n === 1 ? 'needs' : 'need'} action`,
    // Compliance opens on Needs action: these same rows (ADR 073)
    href: c.keeps ? listHref('/compliance', { all: true }) : '/inbox',
    rows,
    more: n - rows.length,
  };
}
