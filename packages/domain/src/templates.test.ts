import { describe, expect, it } from 'vitest';
import {
  CHECKLISTS,
  CHECKLIST_BY_CODE,
  libraryStepsJson,
  newerLibraryVersion,
  type LibraryChecklist,
} from './checklists';
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

  it('a copy is offered the library’s newer version only (ADR 068)', () => {
    const v1 = CHECKLIST_BY_CODE.get('KITCHEN-OPENING')!;
    // up to date, no library, or a code the library no longer has: nothing to offer
    expect(newerLibraryVersion('KITCHEN-OPENING', v1.version)).toBeNull();
    expect(newerLibraryVersion(null, null)).toBeNull();
    expect(newerLibraryVersion('GONE', 1)).toBeNull();
    // the library moves on to version 2
    const v2: LibraryChecklist = { ...v1, version: 2, steps: [...v1.steps] };
    const library = new Map([[v2.code, v2]]);
    expect(newerLibraryVersion('KITCHEN-OPENING', 1, library)).toBe(v2);
    expect(newerLibraryVersion('KITCHEN-OPENING', 2, library)).toBeNull();
  });

  it('library steps keep their range, unit and photo as a checklist stores them', () => {
    const pool = CHECKLIST_BY_CODE.get('POOL-WATER-TEST')!;
    expect(libraryStepsJson(pool)[0]).toEqual({
      label: 'pH',
      kind: 'number',
      min: 7.2,
      max: 7.8,
      unit: 'pH',
    });
    const photo: LibraryChecklist = {
      ...pool,
      steps: [{ label: 'Photo of the deck', kind: 'tick', photo: true }],
    };
    expect(libraryStepsJson(photo)).toEqual([
      { label: 'Photo of the deck', kind: 'tick', photo_required: true },
    ]);
  });
});
