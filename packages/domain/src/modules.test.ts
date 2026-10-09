import { describe, expect, it } from 'vitest';
import { DOMAINS } from './access';
import {
  BASE_DOMAINS,
  MODULES,
  MODULE_CODES,
  moduleOfDomain,
  needsOf,
  onByDefault,
  resolveModules,
} from './modules';

describe('building blocks (ADR 085)', () => {
  it('every domain belongs to exactly one block or to the base', () => {
    const owned = [...MODULES.flatMap((m) => [...m.domains]), ...BASE_DOMAINS];
    expect(new Set(owned).size).toBe(owned.length);
    expect([...owned].sort()).toEqual(DOMAINS.map((d) => d.code).sort());
  });

  it('a derived domain belongs to the block of the domain it is derived from', () => {
    for (const d of DOMAINS.filter((x) => x.code.startsWith('DERIVED_'))) {
      expect(moduleOfDomain(d.code), d.code).toBe(moduleOfDomain(d.code.slice('DERIVED_'.length)));
    }
  });

  it('a block comes after the blocks it needs, and never needs itself', () => {
    MODULE_CODES.forEach((c, i) => {
      for (const n of needsOf(c)) {
        expect(n, c).not.toBe(c);
        expect(MODULE_CODES.indexOf(n), `${c} needs ${n}`).toBeLessThan(i);
      }
    });
  });

  it('every block is on by default but Compliance', () => {
    expect(MODULE_CODES.filter((c) => !onByDefault(c))).toEqual(['compliance']);
  });

  it('named in words, never codes, with one plain line each', () => {
    for (const m of MODULES) {
      expect(m.name).not.toMatch(/_/);
      expect(m.what).toMatch(/\.$/);
    }
  });

  it('a block is off when one it needs is off', () => {
    expect([...resolveModules(MODULE_CODES)].sort()).toEqual([...MODULE_CODES].sort());
    const noStock = resolveModules(MODULE_CODES.filter((c) => c !== 'stock'));
    for (const c of [
      'stock',
      'buying',
      'recipes',
      'production',
      'prep_lists',
      'menu_sales',
      'minibars',
    ]) {
      expect(noStock.has(c as never), c).toBe(false);
    }
    expect(noStock.has('roster')).toBe(true);
    const noRoster = resolveModules(MODULE_CODES.filter((c) => c !== 'roster'));
    expect(['clock_in', 'pay', 'swaps'].filter((c) => noRoster.has(c as never))).toEqual([]);
    expect(noRoster.has('leave')).toBe(true);
  });

  it('the base keeps places and people, access, To do and reports', () => {
    for (const d of ['WORKERS', 'TASKS', 'NOTIFICATIONS', 'USER_ACCESS', 'REPORTS']) {
      expect(moduleOfDomain(d), d).toBeNull();
    }
    expect(moduleOfDomain('COMPENSATION')).toBe('pay');
    expect(moduleOfDomain('LABOUR_COST')).toBe('pay');
    expect(moduleOfDomain('ATTENDANCE')).toBe('clock_in');
  });
});
