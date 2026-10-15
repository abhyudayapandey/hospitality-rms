import { describe, expect, it } from 'vitest';
import { answering } from './answering';

describe('answering', () => {
  it('keeps the roles that run something', () => {
    const roles = [
      { code: 'GENERAL_MANAGER', answers: true },
      { code: 'BAR_BACK', answers: false },
    ];
    expect(answering(roles).map((r) => r.code)).toEqual(['GENERAL_MANAGER']);
  });
  it('offers every role where none runs anything', () => {
    expect(answering([{ code: 'TECHNICIAN', answers: false }]).map((r) => r.code)).toEqual([
      'TECHNICIAN',
    ]);
  });
});
