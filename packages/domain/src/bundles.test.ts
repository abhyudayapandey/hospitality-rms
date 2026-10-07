import { describe, expect, it } from 'vitest';
import {
  BUNDLES,
  bundleOf,
  bundleState,
  bundlesFor,
  missingBundleNotes,
  type Bundle,
} from './bundles';
import { MODULES, MODULE_CODES } from './modules';
import { TEMPLATES, EXTRAS } from './templates';

const byCode = (c: string): Bundle => BUNDLES.find((b) => b.code === c)!;

describe('bundles (ADR 067)', () => {
  it('every module is in exactly one bundle', () => {
    const all = BUNDLES.flatMap((b) => [...b.modules]);
    expect([...all].sort()).toEqual([...MODULE_CODES].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('a module a module needs is in the same bundle, so no bundle depends on another', () => {
    for (const m of MODULES) {
      if ('needs' in m) expect(bundleOf(m.needs).code, m.code).toBe(bundleOf(m.code).code);
    }
  });

  it('bundles are named in words, never codes, and say what comes with them', () => {
    for (const b of BUNDLES) {
      expect(b.name).not.toMatch(/_/);
      expect(b.includes).toMatch(/^Includes .+\.$/);
    }
    expect(BUNDLES.map((b) => b.name)).toEqual([
      'Stock & cost',
      'People & roster',
      'Tasks & food safety',
    ]);
  });

  it('events go with people; production and prep lists with stock', () => {
    expect(bundleOf('events').name).toBe('People & roster');
    expect(bundleOf('production').name).toBe('Stock & cost');
    expect(bundleOf('prep_lists').name).toBe('Stock & cost');
  });

  it('On, Partly on or Off from the modules that are on', () => {
    const people = byCode('people_roster');
    expect(bundleState(people, new Set(['leave', 'swaps', 'events']))).toBe('on');
    expect(bundleState(people, new Set(['leave']))).toBe('partly');
    expect(bundleState(people, new Set(['checklists']))).toBe('off');
  });

  it('the bundles a set of modules uses, in order', () => {
    expect(bundlesFor(['checklists', 'menu_sales', 'events']).map((b) => b.code)).toEqual([
      'stock_cost',
      'people_roster',
      'tasks_food_safety',
    ]);
    expect(bundlesFor([])).toEqual([]);
  });

  it("says in words what an outlet uses that isn't in the plan", () => {
    expect(
      missingBundleNotes(['checklists', 'production'], new Set(['stock_cost', 'people_roster'])),
    ).toEqual([
      "This outlet uses Checklists, part of Tasks & food safety, which isn't on for this customer",
    ]);
    expect(missingBundleNotes(['checklists', 'maintenance'], new Set())).toEqual([
      "This outlet uses Checklists and Maintenance, part of Tasks & food safety, which isn't on for this customer",
    ]);
    expect(missingBundleNotes(['checklists'], new Set(['tasks_food_safety']))).toEqual([]);
    expect(missingBundleNotes(['events'], new Set(), 'Test Bar 3.0')).toEqual([
      "Test Bar 3.0 uses Events, part of People & roster, which isn't on for this customer",
    ]);
  });

  it("every template's and extra's modules are sold in a bundle", () => {
    const used = [
      ...TEMPLATES.flatMap((t) => t.modules),
      ...EXTRAS.flatMap((e) => e.modules ?? []),
    ];
    for (const m of used) expect(bundleOf(m), m).toBeDefined();
  });
});
