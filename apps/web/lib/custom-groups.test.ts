import { describe, expect, it } from 'vitest';
import {
  CARRIABLE_ROLES,
  codeFromName,
  isProductCode,
  RIGHT_OPTIONS,
  rightsPayload,
} from './custom-groups';

describe('custom group options', () => {
  it('offers business rights only, never admin rights or company reports', () => {
    const codes = RIGHT_OPTIONS.map((r) => r.code);
    expect(codes).toContain('ROSTER');
    expect(codes).toContain('STOCK_ADJUSTMENTS');
    for (const admin of [
      'USER_ACCESS',
      'COMPANY_SETTINGS',
      'SECURITY_ROLES',
      'WF_CONFIG',
      'REPORTS',
    ]) {
      expect(codes).not.toContain(admin);
    }
    expect(RIGHT_OPTIONS.find((r) => r.code === 'STOCK_LEVELS')!.where).toBe('a store');
    expect(RIGHT_OPTIONS.find((r) => r.code === 'ROSTER')!.where).toBe('a department or outlet');
  });

  it('can carry business roles, never admin roles or the AI agent', () => {
    const codes = CARRIABLE_ROLES.map((r) => r.code);
    expect(codes).toContain('DEPARTMENT_HEAD');
    expect(codes).toContain('OUTLET_MANAGER');
    for (const no of [
      'ACCOUNT_OWNER',
      'USER_ADMIN',
      'AI_AGENT',
      'SELF',
      'SECURITY_ADMIN',
      'AUDITOR',
    ])
      expect(codes).not.toContain(no);
  });
});

describe('codeFromName', () => {
  it('upper snake case from a name', () => {
    expect(codeFromName('Kitchen lead')).toBe('KITCHEN_LEAD');
    expect(codeFromName('  Bar lead (night) ')).toBe('BAR_LEAD_NIGHT');
    expect(codeFromName('Café supervisor')).toBe('CAFE_SUPERVISOR');
  });
  it('starts with a letter and needs three characters', () => {
    expect(codeFromName('2nd chef')).toBe('ND_CHEF');
    expect(codeFromName('ab')).toBe('');
  });
  it('product codes are taken', () => {
    expect(isProductCode('STAFF')).toBe(true);
    expect(isProductCode('KITCHEN_LEAD')).toBe(false);
  });
});

describe('rightsPayload', () => {
  it('sends only rights set to view or modify, and only known ones', () => {
    expect(
      rightsPayload({ ROSTER: 'modify', TASKS: 'none', LEAVE: 'view', USER_ACCESS: 'modify' }),
    ).toEqual({
      ROSTER: 'modify',
      LEAVE: 'view',
    });
  });
});
