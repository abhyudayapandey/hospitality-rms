import { describe, expect, it } from 'vitest';
import {
  accessSource,
  auditAction,
  auditActor,
  groupLabel,
  sinceText,
  statusLabel,
} from './labels';

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

describe('access rows in words (ADR 149)', () => {
  it('says where access comes from, without the loader’s note', () => {
    expect(accessSource('job_role', 'job role default (bar_pub)')).toBe('comes with the job');
    expect(accessSource('extra', 'covering for Ria')).toBe('given extra · covering for Ria');
  });
  it('a day in words', () => {
    expect(sinceText('2025-09-17', null)).toBe('since 17 Sept 2025');
    expect(sinceText('2025-09-17', '2025-09-30')).toBe('17 Sept 2025 to 30 Sept 2025');
  });
  it('a status in words', () => {
    expect(statusLabel('active')).toBe('Active');
    expect(statusLabel('inactive')).toBe('Not active');
  });
});

describe('the access audit in words (ADR 149)', () => {
  it('names events and the assistant', () => {
    expect(auditAction('user created')).toBe('Person added');
    expect(auditAction('granted')).toBe('Access given');
    expect(auditAction('something new')).toBe('Something new');
    expect(auditActor('Platform')).toBe('the Outlet Ops team');
    expect(groupLabel('AI_AGENT')).toBe('Outlet Ops assistant');
  });
});
