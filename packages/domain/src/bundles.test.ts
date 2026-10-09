import { describe, expect, it } from 'vitest';
import {
  inPlanByDefault,
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

  it('a block may need one in another bundle only when that bundle is Stock & buying', () => {
    for (const m of MODULES) {
      for (const n of 'needs' in m ? m.needs : []) {
        if (bundleOf(n).code !== bundleOf(m.code).code) {
          expect(bundleOf(n).code, `${m.code} needs ${n}`).toBe('stock_buying');
        }
      }
    }
  });

  it('bundles are named in words, never codes, and say what comes with them', () => {
    for (const b of BUNDLES) {
      expect(b.name).not.toMatch(/_/);
      expect(b.adds).toMatch(/^Adds .+\.$/);
    }
    expect(BUNDLES.map((b) => b.name)).toEqual([
      'Stock & buying',
      'Kitchen & bar',
      'People',
      'Daily work',
      'Hotel',
      'Events & compliance',
    ]);
  });

  it('every bundle is in a plan that does not say, but Hotel (ADR 085)', () => {
    expect(BUNDLES.filter((b) => !inPlanByDefault(b)).map((b) => b.code)).toEqual(['hotel']);
  });

  it('salaries and labour cost are part of People; production of Kitchen & bar', () => {
    expect(bundleOf('pay').name).toBe('People');
    expect(bundleOf('clock_in').name).toBe('People');
    expect(bundleOf('production').name).toBe('Kitchen & bar');
    expect(bundleOf('events').name).toBe('Events & compliance');
    expect(bundleOf('minibars').name).toBe('Hotel');
  });

  it('On, Partly on or Off from the modules that are on', () => {
    const people = byCode('people');
    expect(bundleState(people, new Set(['roster', 'clock_in', 'pay', 'leave', 'swaps']))).toBe(
      'on',
    );
    expect(bundleState(people, new Set(['leave']))).toBe('partly');
    expect(bundleState(people, new Set(['checklists']))).toBe('off');
  });

  it('the bundles a set of modules uses, in order', () => {
    expect(bundlesFor(['checklists', 'menu_sales', 'events']).map((b) => b.code)).toEqual([
      'kitchen_bar',
      'daily_work',
      'events_compliance',
    ]);
    expect(bundlesFor([])).toEqual([]);
  });

  it("says in words what an outlet uses that isn't in the plan", () => {
    expect(
      missingBundleNotes(['checklists', 'production'], new Set(['kitchen_bar', 'people'])),
    ).toEqual([
      "This outlet uses Checklists, part of Daily work, which isn't on for this customer",
    ]);
    expect(missingBundleNotes(['checklists', 'maintenance'], new Set())).toEqual([
      "This outlet uses Checklists and Maintenance, part of Daily work, which isn't on for this customer",
    ]);
    expect(missingBundleNotes(['checklists'], new Set(['daily_work']))).toEqual([]);
    expect(missingBundleNotes(['events'], new Set(), 'Test Bar 3.0')).toEqual([
      "Test Bar 3.0 uses Events, part of Events & compliance, which isn't on for this customer",
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
