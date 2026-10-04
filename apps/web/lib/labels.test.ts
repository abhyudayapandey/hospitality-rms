import { describe, expect, it } from 'vitest';
import { groupLabel } from './labels';

describe('groupLabel (UX-11)', () => {
  it('reads an access group code as words', () => {
    expect(groupLabel('DEPARTMENT_HEAD')).toBe('Department head');
    expect(groupLabel('STOCK_USER')).toBe('Stock user');
    expect(groupLabel('STAFF')).toBe('Staff');
  });
  it('nothing for no code', () => {
    expect(groupLabel(null)).toBe('');
    expect(groupLabel(undefined)).toBe('');
  });
});
