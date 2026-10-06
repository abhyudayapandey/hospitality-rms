import { describe, expect, it } from 'vitest';
import {
  DEPARTMENTS,
  ROLES,
  checkCatalogue,
  levelOf,
  type DepartmentDef,
  type RoleDef,
} from './catalogue';

// The role and department catalogue (ADR 060): every role's duties are real and expand
// without a grant twice, every role works somewhere the catalogue knows, and a role's level
// follows from its duties.

describe('role catalogue', () => {
  it('passes its own checks', () => {
    expect(() => checkCatalogue()).not.toThrow();
    expect(ROLES.length).toBeGreaterThan(80);
    expect(DEPARTMENTS.length).toBe(22);
  });

  it('keeps the SOP roles apart from the roles whose codes were taken first', () => {
    const byCode = new Map(ROLES.map((r) => [r.code, r]));
    // a hotel's Store Manager heads Stores; a QSR's runs the outlet
    expect(byCode.get('STORE_MANAGER')).toMatchObject({
      title: 'Store Manager',
      home: 'STORES-TEAM',
    });
    expect(byCode.get('QSR_STORE_MANAGER')).toMatchObject({
      title: 'Store Manager',
      home: '(outlet)',
    });
    expect(levelOf(byCode.get('QSR_STORE_MANAGER')!.duties)).toBe('runs_outlet');
    // a hotel's Restaurant Manager heads a department; a standalone restaurant's runs it
    expect(levelOf(byCode.get('RESTAURANT_MANAGER')!.duties)).toBe('runs_department');
    expect(levelOf(byCode.get('RESTAURANT_GENERAL_MANAGER')!.duties)).toBe('runs_outlet');
    expect(levelOf(byCode.get('KITCHEN_MANAGER')!.duties)).toBe('runs_outlet');
    // decided 6 Oct: the Duty Manager leads the shift; no outlet-wide approvals yet
    expect(levelOf(byCode.get('DUTY_MANAGER')!.duties)).toBe('leads_shift');
    expect(byCode.get('FOOD_SAFETY_SUPERVISOR')!.duties).toContain('LEADS_SHIFT');
  });

  it('works out a level from duties', () => {
    expect(levelOf(['WORKS_SHIFTS', 'MAKES_PREP'])).toBe('works');
    expect(levelOf(['LEADS_SHIFT', 'WORKS_SHIFTS'])).toBe('leads_shift');
    expect(levelOf(['KEEPS_MAIN_STORE', 'WORKS_SHIFTS'])).toBe('leads_shift');
    expect(levelOf(['RUNS_DEPARTMENT', 'RUNS_DEPARTMENT@department:BAR'])).toBe('runs_department');
    expect(levelOf(['RUNS_OUTLET'])).toBe('runs_outlet');
    expect(levelOf(['RUNS_AREA'])).toBe('above_outlet');
    expect(levelOf(['CONTROLS_COSTS', 'WORKS_SHIFTS'])).toBe('works');
  });

  it('refuses unknown duties and places, repeats and grants given twice', () => {
    const role: RoleDef = {
      code: 'X_ROLE',
      title: 'X',
      home: 'KITCHEN',
      duties: ['WORKS_SHIFTS'],
      sops: [],
    };
    const dept: DepartmentDef = { code: 'KITCHEN', name: 'Kitchen', type: 'kitchen', sops: [] };
    expect(() => checkCatalogue([role, role], [dept])).toThrow('listed twice');
    expect(() => checkCatalogue([{ ...role, home: 'NOWHERE' }], [dept])).toThrow(
      'is not a department',
    );
    expect(() => checkCatalogue([{ ...role, duties: ['NOPE'] }], [dept])).toThrow('is not a duty');
    expect(() => checkCatalogue([{ ...role, duties: [] }], [dept])).toThrow('has no duties');
    expect(() =>
      checkCatalogue([{ ...role, duties: ['WORKS_SHIFTS', 'WORKS_SHIFTS'] }], [dept]),
    ).toThrow('given twice');
    expect(() =>
      checkCatalogue([{ ...role, duties: ['WORKS_SHIFTS@department:BAR'] }], [dept]),
    ).toThrow('cannot be given at');
    expect(() => checkCatalogue([role, { ...role, code: 'Y_ROLE' }], [dept])).toThrow(
      'share the title',
    );
  });
});
