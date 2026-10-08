import { describe, expect, it } from 'vitest';
import {
  dayStrip,
  groupByTime,
  peopleTabs,
  pickDay,
  rosterLanding,
  type TabAccess,
} from './roster-view';

type Grants = Record<string, 'view' | 'modify'>;
const access = (g: Grants, personal: boolean, exceptions = false): TabAccess => ({
  can: (d, a = 'view') => g[d] !== undefined && (a === 'view' || g[d] === 'modify'),
  personal,
  exceptions,
});
const hrefs = (t: { href: string }[]) => t.map((x) => x.href);

// Shapes of the product groups (packages/domain/src/access.ts) as people hold them
const SERVER = access(
  { ROSTER: 'view', EVENTS: 'view', LEAVE: 'view', SHIFT_SWAPS: 'modify', ATTENDANCE: 'modify' },
  true,
);
const SOUS_CHEF = access(
  { ROSTER: 'view', EVENTS: 'view', LEAVE: 'view', SHIFT_SWAPS: 'modify', ATTENDANCE: 'modify' },
  true,
);
const MANAGER = access(
  {
    ROSTER: 'modify',
    EVENTS: 'view',
    LEAVE: 'modify',
    SHIFT_SWAPS: 'modify',
    ATTENDANCE: 'modify',
  },
  true,
  true,
);
const HR_HEAD_OFFICE = access(
  { ROSTER: 'view', LEAVE: 'modify', ATTENDANCE: 'modify' },
  false,
  true,
);
const AREA_MANAGER = access({ ROSTER: 'view', EVENTS: 'view' }, false);
const EVENT_PLANNER = access({ ROSTER: 'view', EVENTS: 'modify', LEAVE: 'view' }, true);

describe('peopleTabs (Me / Team)', () => {
  it('frontline staff have only Me: no roster, exceptions or events tab', () => {
    const t = peopleTabs(SERVER);
    expect(hrefs(t.me)).toEqual(['/roster/my', '/roster/clock', '/leave', '/roster/swaps']);
    expect(t.team).toEqual([]);
    expect(peopleTabs(SOUS_CHEF).team).toEqual([]);
  });
  it('a roster builder who works shifts has both sides', () => {
    const t = peopleTabs(MANAGER);
    expect(hrefs(t.me)).toEqual(['/roster/my', '/roster/clock', '/leave', '/roster/swaps']);
    expect(hrefs(t.team)).toEqual(['/roster/week', '/roster/exceptions', '/events']);
  });
  it('people above outlet level: Team, and Leave when they hold it; no personal tabs', () => {
    const hr = peopleTabs(HR_HEAD_OFFICE);
    expect(hrefs(hr.me)).toEqual(['/leave']);
    expect(hrefs(hr.team)).toEqual(['/roster/week', '/roster/exceptions']);
    const am = peopleTabs(AREA_MANAGER);
    expect(am.me).toEqual([]);
    expect(hrefs(am.team)).toEqual(['/roster/week', '/events']);
  });
  it('an event planner gets Events on the Team side', () => {
    expect(hrefs(peopleTabs(EVENT_PLANNER).team)).toEqual(['/events']);
  });
  it('nothing without the domains', () => {
    const t = peopleTabs(access({}, true));
    expect(t).toEqual({ me: [], team: [] });
  });
});

describe('rosterLanding', () => {
  it('builders and people above outlet level open on Team, staff on My shifts', () => {
    expect(rosterLanding(MANAGER)).toBe('/roster/week');
    expect(rosterLanding(HR_HEAD_OFFICE)).toBe('/roster/week');
    expect(rosterLanding(AREA_MANAGER)).toBe('/roster/week');
    expect(rosterLanding(SERVER)).toBe('/roster/my');
    expect(rosterLanding(EVENT_PLANNER)).toBe('/roster/my');
    expect(rosterLanding(access({}, true))).toBeNull();
  });
});

const WEEK = [
  '2026-09-28',
  '2026-09-29',
  '2026-09-30',
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
];
const shift = (
  id: string,
  day: string,
  start: string,
  end: string,
  headcount: number,
  people: number,
  status = 'published',
) => ({
  id,
  local_date: day,
  start_at: new Date(start),
  end_at: new Date(end),
  status,
  headcount,
  people: Array.from({ length: people }, (_, i) => i),
});

describe('dayStrip', () => {
  it('counts shifts, open slots and drafts per day', () => {
    const s = dayStrip(
      [
        shift('a', WEEK[0]!, '2026-09-28T00:30:00Z', '2026-09-28T08:30:00Z', 3, 1),
        shift('b', WEEK[0]!, '2026-09-28T11:30:00Z', '2026-09-28T19:30:00Z', 2, 2, 'draft'),
        shift('c', WEEK[2]!, '2026-09-30T11:30:00Z', '2026-09-30T19:30:00Z', 1, 3),
      ],
      WEEK,
    );
    expect(s).toHaveLength(7);
    expect(s[0]).toEqual({ day: WEEK[0], shifts: 2, open: 2, drafts: 1 });
    expect(s[1]).toEqual({ day: WEEK[1], shifts: 0, open: 0, drafts: 0 });
    // more people than slots never counts as negative open slots
    expect(s[2]).toEqual({ day: WEEK[2], shifts: 1, open: 0, drafts: 0 });
  });
});

describe('pickDay', () => {
  it('the asked day if in the week, else today, else Monday', () => {
    expect(pickDay(WEEK, WEEK[3], WEEK[4]!)).toBe(WEEK[3]);
    expect(pickDay(WEEK, '2026-10-09', WEEK[4]!)).toBe(WEEK[4]);
    expect(pickDay(WEEK, undefined, '2026-10-20')).toBe(WEEK[0]);
    expect(pickDay(WEEK, 'nonsense', '2026-10-20')).toBe(WEEK[0]);
  });
});

describe('groupByTime', () => {
  it('groups by start and end, earliest first, with open slots per group', () => {
    const g = groupByTime([
      shift('eve-host', WEEK[0]!, '2026-09-28T11:30:00Z', '2026-09-28T19:30:00Z', 1, 0),
      shift('morn', WEEK[0]!, '2026-09-28T00:30:00Z', '2026-09-28T08:30:00Z', 2, 1),
      shift('eve-server', WEEK[0]!, '2026-09-28T11:30:00Z', '2026-09-28T19:30:00Z', 3, 1),
      shift('late', WEEK[0]!, '2026-09-28T11:30:00Z', '2026-09-28T21:30:00Z', 1, 1),
    ]);
    expect(g.map((x) => x.shifts.map((s) => s.id))).toEqual([
      ['morn'],
      ['eve-host', 'eve-server'],
      ['late'],
    ]);
    expect(g.map((x) => x.open)).toEqual([1, 3, 0]);
  });
  it('no shifts, no groups', () => {
    expect(groupByTime([])).toEqual([]);
  });
});

describe('swaps for management only (SW-4, ADR 074)', () => {
  it('a server has no Swaps tab when the company keeps swaps for managers; a manager does', () => {
    const only = (a: TabAccess): TabAccess => ({ ...a, swapsManagersOnly: true });
    expect(hrefs(peopleTabs(only(SERVER)).me)).not.toContain('/roster/swaps');
    expect(hrefs(peopleTabs(only(MANAGER)).me)).toContain('/roster/swaps');
    // with the setting off, staff swap among themselves
    expect(hrefs(peopleTabs(SERVER).me)).toContain('/roster/swaps');
  });
});
