import { describe, expect, it } from 'vitest';
import { byLevel, coverSentence, coverWarnings, type CoverFacts } from './cover';

const facts = (f: Partial<CoverFacts>): CoverFacts => ({
  outlet: 'Test Bar 3.0',
  role: 'Executive Chef',
  answer: 'covered_by',
  by: 'Commis',
  holders: 0,
  coverers: 2,
  roleDuties: ['RUNS_DEPARTMENT', 'KEEPS_DEPARTMENT_STORE'],
  byDuties: ['WORKS_SHIFTS', 'MAKES_PREP'],
  ...f,
});

describe('coverWarnings (file 37 and Admin, ADR 061, 065)', () => {
  it('warns when someone lower covers a department head or above', () => {
    expect(coverWarnings(facts({}))).toEqual([
      'Commis (works) covers Executive Chef (runs department) at Test Bar 3.0: check that is meant',
    ]);
    // a department head covering a department head, or anyone covering a shift lead: fine
    expect(coverWarnings(facts({ by: 'Sous Chef', byDuties: ['RUNS_DEPARTMENT'] }))).toEqual([]);
    expect(
      coverWarnings(facts({ role: 'Sous Chef', roleDuties: ['LEADS_SHIFT', 'WORKS_SHIFTS'] })),
    ).toEqual([]);
    // a scoped duty (DUTY@department:BAR) counts as the duty
    expect(
      coverWarnings(facts({ by: 'F&B Manager', byDuties: ['RUNS_DEPARTMENT@department:BAR'] })),
    ).toEqual([]);
  });

  it('warns when nobody is in the covering role, or people still hold the covered one', () => {
    expect(
      coverWarnings(facts({ by: 'Sous Chef', byDuties: ['RUNS_DEPARTMENT'], coverers: 0 })),
    ).toEqual(["nobody at Test Bar 3.0 is a Sous Chef yet, so nobody does Executive Chef's work"]);
    expect(
      coverWarnings(facts({ by: 'Sous Chef', byDuties: ['RUNS_DEPARTMENT'], holders: 1 })),
    ).toEqual([
      'Test Bar 3.0 has 1 Executive Chef: they and every Sous Chef there will share its work',
    ]);
    expect(coverWarnings(facts({ answer: 'not_done', by: null, holders: 1 }))).toEqual([
      'Test Bar 3.0 has 1 Executive Chef: its checklists stop all the same',
    ]);
    expect(coverWarnings(facts({ answer: 'not_done', by: null }))).toEqual([]);
  });

  it('"We have it" with nobody in the role says so', () => {
    expect(coverWarnings(facts({ answer: 'have', by: null }))).toEqual([
      'nobody at Test Bar 3.0 is an Executive Chef yet, so nobody does its work',
    ]);
    expect(coverWarnings(facts({ answer: 'have', by: null, holders: 2 }))).toEqual([]);
  });
});

describe('coverSentence', () => {
  const duties = [
    'Leads the shift',
    'Works shifts in the department',
    "Uses the department's store",
  ];
  it('says what moves, in plain words', () => {
    expect(
      coverSentence({ role: 'Sous Chef', answer: 'covered_by', by: 'Executive Chef', duties }),
    ).toBe(
      "The Executive Chef does the Sous Chef's work here: leads the shift, works shifts in the " +
        "department and uses the department's store. Its tasks go to the Executive Chef on duty.",
    );
    expect(coverSentence({ role: 'Store Keeper', answer: 'not_done', duties })).toBe(
      "Nobody does the Store Keeper's work here: its checklists stop, and its approvals and " +
        'alerts go to the department head, then the General Manager.',
    );
    expect(
      coverSentence({
        role: 'Store Keeper',
        answer: 'have',
        wasBy: 'General Manager',
        duties: ['Keeps the Main Store'],
      }),
    ).toBe(
      'The General Manager stops covering; the Store Keeper does this work again: keeps the Main Store.',
    );
    expect(coverSentence({ role: 'Host', answer: 'have', duties: [] })).toBe(
      'The Host does this work here: its access and its tasks.',
    );
  });
});

describe('byLevel', () => {
  it('puts the outlet manager first, then department heads, then shift leads, then staff', () => {
    const roles = [
      { name: 'Commis', duties: ['WORKS_SHIFTS'] },
      { name: 'Sous Chef', duties: ['LEADS_SHIFT'] },
      { name: 'General Manager', duties: ['RUNS_OUTLET'] },
      { name: 'Bar Manager', duties: ['RUNS_DEPARTMENT'] },
      { name: 'Bartender', duties: ['WORKS_SHIFTS'] },
    ];
    expect(byLevel(roles).map((r) => r.name)).toEqual([
      'General Manager',
      'Bar Manager',
      'Sous Chef',
      'Bartender',
      'Commis',
    ]);
  });
});
