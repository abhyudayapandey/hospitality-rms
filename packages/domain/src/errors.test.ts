import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGES, ROSTER_RULE_CODES, errorCodeOf, failure, messageFor } from './errors';

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

  it('has a message for every code the migrations raise', () => {
    // wf.fail('CODE', ...), inv.fail('CODE', ...) and raise exception 'CODE' in any migration.
    const dir = join(import.meta.dirname, '..', '..', 'db', 'migrations');
    const raised = new Set<string>();
    for (const file of readdirSync(dir)) {
      const sql = readFileSync(join(dir, file), 'utf8');
      for (const m of sql.matchAll(/\b(?:\w+\.fail\(|raise exception )'([A-Z][A-Z_]+)'/g)) {
        raised.add(m[1]!);
      }
    }
    expect(raised.size).toBeGreaterThan(10);
    // Schema/setup guards that only a developer or migration can hit.
    const internal = new Set([
      'DOMAIN_TABLE_NOT_REGISTERED',
      'DOMAIN_TREE_MISMATCH',
      'NODE_COLUMN_MISSING',
      'OWNER_COLUMN_MISSING',
      'INVALID_RESOLVER',
      'LTREE_WRONG_SCHEMA',
      'INVALID_PARENT',
      'INVALID_NODE_LINK',
      'HANDLER_NOT_FOUND', // executor-side; recorded on the outbox row
      'INVALID_KEY', // the test-data loader's attendance (ADR 030); platform_loader only
      'INVALID_DAYS', // inv.expiry_list: the app always asks for 3 days (ADR 033)
    ]);
    const missing = [...raised].filter((c) => !internal.has(c) && !(c in ERROR_MESSAGES));
    expect(missing).toEqual([]);
  });

  it('has a message for every reason core.role_cover_errors gives (ADR 065)', () => {
    const sql = readFileSync(
      join(import.meta.dirname, '..', '..', 'db', 'migrations', '20261114100000_role_cover.sql'),
      'utf8',
    );
    const body = sql.slice(
      sql.indexOf('create function core.role_cover_errors'),
      sql.indexOf('create or replace function core.derive_job_role_access'),
    );
    const codes = new Set(
      [...body.matchAll(/select (?:distinct )?'([A-Z][A-Z_]+)'/g)].map((m) => m[1]!),
    );
    expect(codes.size).toBeGreaterThanOrEqual(7);
    expect([...codes].filter((c) => !(c in ERROR_MESSAGES))).toEqual([]);
  });

  it('knows every rostering rule code hr.assignment_violation returns', () => {
    const dir = join(import.meta.dirname, '..', '..', 'db', 'migrations');
    const returned = new Set<string>();
    for (const file of readdirSync(dir)) {
      const sql = readFileSync(join(dir, file), 'utf8');
      for (const m of sql.matchAll(/return query select '([A-Z][A-Z_]+)'::text/g)) {
        returned.add(m[1]!);
      }
    }
    expect(returned.size).toBeGreaterThan(5);
    expect(
      [...returned].filter((c) => !(ROSTER_RULE_CODES as readonly string[]).includes(c)),
    ).toEqual([]);
  });
});
