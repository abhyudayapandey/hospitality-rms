import { describe, expect, it } from 'vitest';
import { approvalHeadline } from './approval-words';

describe('approvalHeadline', () => {
  it('names the GM where the outlet has the GM approve every request', () => {
    expect(approvalHeadline({ approver: 'gm', rule: 'every' }, 'transfer')).toBe(
      'The GM approves every request here.',
    );
  });
  it('names the department head for an unusual request', () => {
    expect(approvalHeadline({ approver: 'department_head', rule: 'unusual' }, 'transfer')).toBe(
      'Your department head will be asked to approve this:',
    );
  });
  it('names the GM for an order the GM approves', () => {
    expect(approvalHeadline({ approver: 'gm', rule: 'above' }, 'order')).toBe(
      'The GM will be asked to approve this:',
    );
    expect(approvalHeadline({ approver: 'gm', rule: 'every' }, 'order')).toBe(
      'The GM approves every order here.',
    );
  });
});
