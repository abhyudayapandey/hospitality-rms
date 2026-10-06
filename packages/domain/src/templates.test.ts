import { describe, expect, it } from 'vitest';
import { CHECKLISTS } from './checklists';
import { ROLE_BY_CODE } from './catalogue';
import {
  EXTRA_BY_CODE,
  TEMPLATES,
  TILES,
  checkTemplates,
  inView,
  roleDepartment,
} from './templates';

// Outlet templates (ADR 062): every piece is a real department, role or library checklist,
// every role works somewhere its outlet can have, and the café and restaurant views of one
// template differ only in what is on first.

describe('outlet templates', () => {
  it('pass their own checks', () => {
    expect(() => checkTemplates()).not.toThrow();
    expect(TEMPLATES.map((t) => t.format)).toEqual([
      'restaurant',
      'bar_pub',
      'qsr',
      'cloud_kitchen',
      'hotel',
    ]);
  });

  it('give every role a department its outlet can have, or the outlet itself', () => {
    for (const tile of TILES) {
      const t = TEMPLATES.find((x) => x.format === tile.format)!;
      const can = new Set([
        ...t.departments.map((d) => d.code),
        ...tile.offers.flatMap((x) => EXTRA_BY_CODE.get(x)!.departments ?? []),
      ]);
      for (const r of [
        ...t.roles,
        ...tile.offers.flatMap((x) => EXTRA_BY_CODE.get(x)!.roles ?? []),
      ]) {
        const role = ROLE_BY_CODE.get(r.code)!;
        const at = roleDepartment(r, role, t.format);
        if (at.startsWith('(') || EXTRA_BY_CODE.get('central_kitchen')!.roles!.includes(r))
          continue;
        expect(can.has(at), `${tile.code}: ${r.code} works in ${at}`).toBe(true);
      }
    }
  });

  it('a café and a restaurant are one template: the café view has its own pieces on', () => {
    const t = TEMPLATES.find((x) => x.format === 'restaurant')!;
    const on = (view: 'cafe' | 'restaurant') =>
      t.departments.filter((d) => d.on !== false && inView(d, view)).map((d) => d.code);
    expect(on('cafe')).toEqual(['KITCHEN', 'COUNTER']);
    expect(on('restaurant')).toEqual(['KITCHEN', 'RESTAURANT', 'STORES-TEAM']);
    expect(t.checklists.filter((c) => inView(c, 'cafe')).map((c) => c.code)).toContain(
      'COUNTER-OPENING',
    );
  });

  it('library checklists have unique codes, a version and steps', () => {
    expect(new Set(CHECKLISTS.map((c) => c.code)).size).toBe(CHECKLISTS.length);
    for (const c of CHECKLISTS) {
      expect(c.version, c.code).toBeGreaterThan(0);
      expect(c.steps.length, c.code).toBeGreaterThan(0);
      expect(c.steps.length, c.code).toBeLessThanOrEqual(30);
    }
  });
});
