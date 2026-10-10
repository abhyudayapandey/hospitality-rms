import { describe, expect, it } from 'vitest';
import { leaveIcon } from './leave-icons';

describe('leave pictures (ADR 107)', () => {
  it('each test-data leave type has its own picture', () => {
    const types = [
      ['CASUAL_LEAVE', 'Casual Leave'],
      ['SICK_LEAVE', 'Sick Leave'],
      ['EARNED_LEAVE', 'Earned Leave'],
      ['COMPENSATORY_OFF', 'Compensatory Off'],
      ['UNPAID_LEAVE', 'Unpaid Leave'],
    ] as const;
    const icons = types.map(([c, n]) => leaveIcon(c, n));
    expect(icons).toEqual(['umbrella', 'medkit', 'palm', 'compOff', 'rupee']);
  });

  it("a customer's own names: by their words, else the calendar", () => {
    expect(leaveIcon('PL', 'Privilege leave')).toBe('palm');
    expect(leaveIcon('ML', 'Maternity leave')).toBe('people');
    expect(leaveIcon('BL', 'Bereavement')).toBe('calendar');
  });
});
