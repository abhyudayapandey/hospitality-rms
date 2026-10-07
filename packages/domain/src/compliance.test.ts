import { describe, expect, it } from 'vitest';
import {
  CALENDAR_JOBS,
  calendarFor,
  daysWords,
  everyWords,
  firstDue,
  LICENCE_KINDS,
  licencesFor,
} from './compliance';
import { ROLE_BY_CODE } from './catalogue';
import { EXTRA_BY_CODE } from './templates';

// The compliance library (ADR 069): from the SOPs' licence lists and calendars.

describe('the compliance library', () => {
  it('has unique codes, a source for everything, and valid intervals', () => {
    expect(new Set(LICENCE_KINDS.map((k) => k.code)).size).toBe(LICENCE_KINDS.length);
    expect(new Set(CALENDAR_JOBS.map((j) => j.code)).size).toBe(CALENDAR_JOBS.length);
    for (const x of [...LICENCE_KINDS, ...CALENDAR_JOBS]) {
      expect(x.from.length, x.code).toBeGreaterThan(5);
      for (const e of x.extras ?? []) expect(EXTRA_BY_CODE.has(e), `${x.code} ${e}`).toBe(true);
    }
    for (const j of CALENDAR_JOBS) {
      expect([1, 2, 3, 4, 6, 12, 24, 36], j.code).toContain(j.everyMonths);
      expect(j.version, j.code).toBeGreaterThan(0);
    }
    // a library job's owner resolves to a catalogue role at the outlet
    expect(ROLE_BY_CODE.has('CHIEF_ENGINEER')).toBe(true);
  });

  it('a hotel with a pool needs the pool licence; a bar its excise licence; a café neither', () => {
    expect(licencesFor('hotel', ['pool']).map((k) => k.code)).toContain('SWIMMING_POOL');
    expect(licencesFor('hotel', []).map((k) => k.code)).not.toContain('SWIMMING_POOL');
    expect(licencesFor('bar_pub', []).map((k) => k.code)).toContain('EXCISE_BAR');
    expect(licencesFor('restaurant', ['bar']).map((k) => k.code)).toContain('EXCISE_BAR');
    expect(licencesFor('restaurant', []).map((k) => k.code)).not.toContain('EXCISE_BAR');
    for (const f of ['restaurant', 'bar_pub', 'qsr', 'cloud_kitchen', 'hotel'] as const) {
      expect(
        licencesFor(f, []).map((k) => k.code),
        f,
      ).toContain('FSSAI');
      expect(
        calendarFor(f, []).map((j) => j.code),
        f,
      ).toContain('PEST-CONTROL');
    }
    expect(calendarFor('hotel', []).map((j) => j.code)).toContain('LIFT-RESCUE-DRILL');
    expect(calendarFor('qsr', []).map((j) => j.code)).not.toContain('LIFT-RESCUE-DRILL');
  });

  it('a first due date: 30 days on, or the fixed yearly date', () => {
    const pest = CALENDAR_JOBS.find((j) => j.code === 'PEST-CONTROL')!;
    const d1 = CALENDAR_JOBS.find((j) => j.code === 'FSSAI-ANNUAL-RETURN')!;
    expect(firstDue(pest, '2026-10-07')).toBe('2026-11-06');
    expect(firstDue(d1, '2026-10-07')).toBe('2027-05-31');
    expect(firstDue(d1, '2026-05-01')).toBe('2026-05-31');
  });

  it('says days and intervals in words', () => {
    expect(daysWords(45, 'Expires')).toBe('Expires in 45 days');
    expect(daysWords(1, 'Due')).toBe('Due in 1 day');
    expect(daysWords(0, 'Due')).toBe('Due today');
    expect(daysWords(-3, 'Expires')).toBe('Expired 3 days ago');
    expect(daysWords(-1, 'Due')).toBe('Overdue 1 day');
    expect([1, 3, 6, 12, 24].map(everyWords)).toEqual([
      'Every month',
      'Every 3 months',
      'Every 6 months',
      'Every year',
      'Every 2 years',
    ]);
  });
});
