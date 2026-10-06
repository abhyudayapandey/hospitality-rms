import { describe, expect, it } from 'vitest';
import { ACCESS_GROUPS } from './access';
import { DUTIES, checkDuties, expandDuty, isScope, type DutyDef } from './duties';

// The duty catalogue (ADR 059): every duty stands for real groups at real scopes, and a
// duty given at another department is the only one whose scope can move.

describe('duty catalogue', () => {
  it('passes its own checks and uses only product groups and scope words', () => {
    expect(() => checkDuties()).not.toThrow();
    const groups = new Set(ACCESS_GROUPS.map((g) => g.code));
    for (const d of DUTIES) {
      expect(d.name.length).toBeGreaterThan(3);
      expect(d.does.length).toBeGreaterThan(3);
      for (const g of d.grants) {
        expect(groups.has(g.group), `${d.code}: ${g.group}`).toBe(true);
        expect(isScope(g.scope), `${d.code}: ${g.scope}`).toBe(true);
      }
    }
  });

  it('no two duties stand for the same grants', () => {
    const seen = new Map<string, string>();
    for (const d of DUTIES) {
      const k = d.grants
        .map((g) => `${g.group}@${g.scope}${g.thisPlaceOnly ? '!' : ''}`)
        .sort()
        .join('+');
      expect(seen.get(k), `${d.code} repeats ${seen.get(k)}`).toBeUndefined();
      seen.set(k, d.code);
    }
  });

  it('expands a duty to its grants, at another department only where allowed', () => {
    expect(expandDuty('RUNS_OUTLET')).toEqual([
      {
        duty: 'RUNS_OUTLET',
        group: 'OUTLET_MANAGER',
        scope: 'whole_outlet',
        includeDescendants: true,
      },
      {
        duty: 'RUNS_OUTLET',
        group: 'OUTLET_MANAGER',
        scope: 'outlet_stores',
        includeDescendants: true,
      },
    ]);
    expect(expandDuty('RUNS_CENTRAL_KITCHEN_STORE')[0]).toMatchObject({
      group: 'HUB_MANAGER',
      includeDescendants: false,
    });
    expect(expandDuty('RUNS_DEPARTMENT', 'department:BAR')).toEqual([
      {
        duty: 'RUNS_DEPARTMENT',
        group: 'DEPARTMENT_HEAD',
        scope: 'department:BAR',
        includeDescendants: true,
      },
    ]);
    expect(() => expandDuty('WORKS_SHIFTS', 'department:BAR')).toThrow('cannot be given at');
    expect(() => expandDuty('RUNS_DEPARTMENT', 'whole_outlet')).toThrow('cannot be given at');
    expect(() => expandDuty('NO_SUCH_DUTY')).toThrow('is not a duty');
  });

  it('refuses a catalogue with unknown groups, bad scopes or repeats', () => {
    const base: DutyDef = {
      code: 'X_DUTY',
      name: 'X duty',
      does: 'Does X',
      grants: [{ group: 'STAFF', scope: 'home_department' }],
    };
    expect(() => checkDuties([base, base])).toThrow('listed twice');
    expect(() => checkDuties([{ ...base, grants: [] }])).toThrow('no grants');
    expect(() =>
      checkDuties([{ ...base, grants: [{ group: 'NOPE', scope: 'home_department' }] }]),
    ).toThrow('is not an access group');
    expect(() =>
      checkDuties([{ ...base, grants: [{ group: 'STAFF', scope: 'nowhere' as 'whole_outlet' }] }]),
    ).toThrow('is not a scope');
    expect(() =>
      checkDuties([
        {
          ...base,
          atAnotherDepartment: true,
          grants: [
            { group: 'STAFF', scope: 'home_department' },
            { group: 'SUPERVISOR', scope: 'home_department' },
          ],
        },
      ]),
    ).toThrow('only a one-grant duty');
  });
});
