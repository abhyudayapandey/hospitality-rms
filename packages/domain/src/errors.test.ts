import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGES, errorCodeOf, failure, messageFor } from './errors';

describe('error mapping', () => {
  it('maps our raised codes (the error message) to user messages', () => {
    expect(errorCodeOf(new Error('SEGREGATION_OF_DUTIES'))).toBe('SEGREGATION_OF_DUTIES');
    expect(messageFor('NO_APPROVER')).toMatch(/approve/);
  });

  it('treats Postgres insufficient_privilege (RLS/grants) as NOT_AUTHORISED', () => {
    const err = Object.assign(new Error('permission denied for table request'), { code: '42501' });
    expect(errorCodeOf(err)).toBe('NOT_AUTHORISED');
  });

  it('never exposes raw SQL errors', () => {
    const err = Object.assign(new Error('syntax error at or near "selec"'), { code: '42601' });
    expect(failure(err)).toEqual({
      ok: false,
      code: 'UNEXPECTED',
      message: ERROR_MESSAGES.UNEXPECTED,
    });
    expect(errorCodeOf('toString')).toBe('UNEXPECTED');
    expect(errorCodeOf({ message: 'constructor' })).toBe('UNEXPECTED');
    expect(errorCodeOf(null)).toBe('UNEXPECTED');
  });

  it('has a message for every code the database raises', () => {
    for (const code of [
      'NOT_AUTHORISED',
      'SEGREGATION_OF_DUTIES',
      'NO_APPROVER',
      'INVALID_STATE',
      'INVALID_ACTION',
      'REQUEST_NOT_FOUND',
      'UNKNOWN_PROCESS',
      'INVALID_SUBJECT',
      'INVALID_PROCESS_DEF',
      'TENANT_MISMATCH',
    ]) {
      expect(ERROR_MESSAGES).toHaveProperty(code);
    }
  });
});
