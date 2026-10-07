// Roster as two sides (UX review U-10, U-11; ADR 025): "Me" (my shifts, clock, leave,
// swaps) and "Team" (roster, exceptions, events; people and the team's leave, ADR 035), and
// the week roster as a day strip.
// Pure, so they can be unit tested; which tabs show still comes from the person's domain
// access (rule 2), never from a check made here.

export type Side = 'me' | 'team';

export interface PeopleTabDef {
  href: string;
  label: string;
  side: Side;
}

export const PEOPLE_TABS = [
  { href: '/roster/my', label: 'My shifts', side: 'me' },
  { href: '/roster/clock', label: 'Clock', side: 'me' },
  { href: '/leave', label: 'Leave', side: 'me' },
  { href: '/roster/swaps', label: 'Swaps', side: 'me' },
  { href: '/roster/week', label: 'Roster', side: 'team' },
  { href: '/roster/exceptions', label: 'Exceptions', side: 'team' },
  { href: '/events', label: 'Events', side: 'team' },
  // UX-5 (ADR 035): worker records and the team's leave, for HR and leads
  { href: '/team/people', label: 'People', side: 'team' },
  { href: '/team/leave', label: 'Leave', side: 'team' },
] as const satisfies readonly PeopleTabDef[];

export type PeopleTab = (typeof PEOPLE_TABS)[number]['href'];

export interface TabAccess {
  /** has (domain, access) in the person's access somewhere */
  can(domain: string, access?: 'view' | 'modify'): boolean;
  /** works at an outlet: has shifts, a clock and swaps of their own */
  personal: boolean;
  /** resolves attendance exceptions somewhere */
  exceptions: boolean;
  /** the company keeps swaps for those who change the roster (SW-4, ADR 035, 074) */
  swapsManagersOnly?: boolean;
}

/**
 * The tabs on each side. Me is the person's own: shifts, clock and swaps when they work at
 * an outlet, and leave. Team is for people who run one: Roster for roster builders (and
 * for people above outlet level, who have no shifts of their own), Exceptions for those
 * who resolve them, Events for event planners and anyone else on the Team side. Frontline
 * staff have no Team side; they see the week's events on My shifts instead.
 */
export function peopleTabs(a: TabAccess): Record<Side, PeopleTabDef[]> {
  const me: PeopleTabDef[] = PEOPLE_TABS.filter((t) => t.side === 'me').filter((t) => {
    switch (t.href) {
      case '/roster/my':
        return a.personal && a.can('ROSTER');
      case '/roster/clock':
        return a.personal && a.can('ATTENDANCE', 'modify');
      case '/roster/swaps':
        // with swaps for management only, staff have no Swaps tab (SW-4)
        return (
          a.personal && a.can('SHIFT_SWAPS') && (!a.swapsManagersOnly || a.can('ROSTER', 'modify'))
        );
      default:
        return a.can('LEAVE');
    }
  });
  const roster = a.can('ROSTER', 'modify') || (!a.personal && a.can('ROSTER'));
  const events = a.can('EVENTS') && (roster || a.exceptions || a.can('EVENTS', 'modify'));
  // People and the team's leave: those who manage worker records (HR, outlet managers);
  // everyone holds WORKERS view on their own record, so view alone is not enough
  const people = a.can('WORKERS', 'modify');
  const team: PeopleTabDef[] = PEOPLE_TABS.filter((t) => t.side === 'team').filter((t) => {
    switch (t.href) {
      case '/roster/week':
        return roster;
      case '/roster/exceptions':
        return a.exceptions;
      case '/events':
        return events;
      case '/team/people':
        return people;
      default:
        return people && a.can('LEAVE');
    }
  });
  return { me, team };
}

/**
 * Where Roster in the nav opens: Team for roster builders and for people with no shifts of
 * their own; My shifts (the first of Me) for everyone else.
 */
export function rosterLanding(a: TabAccess): string | null {
  const { me, team } = peopleTabs(a);
  const teamFirst = a.can('ROSTER', 'modify') || !a.personal;
  return ((teamFirst ? team[0] : me[0]) ?? team[0] ?? me[0])?.href ?? null;
}

export interface StripShift {
  id: string;
  local_date: string;
  start_at: Date | string;
  end_at: Date | string;
  status: string;
  headcount: number;
  people: readonly unknown[];
}

export interface StripDay {
  day: string;
  shifts: number;
  open: number;
  drafts: number;
}

const openSlots = (s: StripShift) => Math.max(0, s.headcount - s.people.length);

/** One chip per day: how many shifts, open slots and drafts. */
export function dayStrip(shifts: readonly StripShift[], days: readonly string[]): StripDay[] {
  return days.map((day) => {
    const list = shifts.filter((s) => s.local_date === day);
    return {
      day,
      shifts: list.length,
      open: list.reduce((n, s) => n + openSlots(s), 0),
      drafts: list.filter((s) => s.status === 'draft').length,
    };
  });
}

/** The day to show: the one asked for if it is in the week, else today, else Monday. */
export function pickDay(days: readonly string[], asked: string | undefined, today: string): string {
  if (asked && days.includes(asked)) return asked;
  return days.includes(today) ? today : days[0]!;
}

export interface TimeGroup<S> {
  key: string;
  start_at: Date | string;
  end_at: Date | string;
  shifts: S[];
  open: number;
}

/** A day's shifts grouped by start and end time, earliest first, keeping each group's order. */
export function groupByTime<S extends StripShift>(shifts: readonly S[]): TimeGroup<S>[] {
  const groups = new Map<string, TimeGroup<S>>();
  const ms = (d: Date | string) => new Date(d).getTime();
  for (const s of [...shifts].sort((a, b) => ms(a.start_at) - ms(b.start_at))) {
    const key = `${ms(s.start_at)}-${ms(s.end_at)}`;
    const g = groups.get(key) ?? {
      key,
      start_at: s.start_at,
      end_at: s.end_at,
      shifts: [],
      open: 0,
    };
    g.shifts.push(s);
    g.open += openSlots(s);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * Whether My shifts offers a Swap button (SW-4, ADR 035): swap access, and when the company
 * keeps swaps for management, the right to change the roster. hr.request_swap checks the
 * same at the shift's place.
 */
export function canOfferSwap(a: TabAccess, managersOnly: boolean): boolean {
  return a.can('SHIFT_SWAPS', 'modify') && (!managersOnly || a.can('ROSTER', 'modify'));
}
