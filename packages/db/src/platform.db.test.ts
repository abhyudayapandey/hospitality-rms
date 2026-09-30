import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  sqlState,
  type SeedIds,
} from '../test/helpers';

// The Platform Admin console (ADR 012), written before the feature. Platform admins live
// outside every customer: a platform session reads no customer data even if app.user_id
// is also set; customers cannot call platform functions; suspending a customer ends every
// session and sign-in of theirs; the platform audit is append-only; is_test is fixed at
// creation; the loader's role (platform_loader) has no DDL rights and owns nothing.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

type Result<T> = { rows: T[]; error?: undefined } | { rows?: undefined; error: string };

/** Runs as app_rw in a platform session (optionally with a customer user id set too). */
async function asPlatform<T extends object = Record<string, unknown>>(
  c: PoolClient,
  adminId: string,
  sql: string,
  params: unknown[] = [],
  alsoUserId: string | null = null,
): Promise<Result<T>> {
  await c.query('set local role app_rw');
  await c.query(`select set_config('app.platform_admin_id', $1, true)`, [adminId]);
  await c.query(`select set_config('app.user_id', $1, true)`, [alsoUserId ?? '']);
  await c.query('savepoint platform');
  try {
    const r = await c.query<T>(sql, params);
    await c.query('release savepoint platform');
    return { rows: r.rows };
  } catch (err) {
    await c.query('rollback to savepoint platform');
    return { error: (err as Error).message };
  } finally {
    await resetRole(c);
    await c.query(`select set_config('app.platform_admin_id', '', true)`);
  }
}

async function newAdmin(c: PoolClient, sub = 'platform-sub-1'): Promise<string> {
  await c.query('set local role app_rw');
  const r = await c.query<{ id: string }>(
    `select platform.sign_in($1, 'admin@example.test') as id`,
    [sub],
  );
  await resetRole(c);
  // sign_in marks its own transaction as the admin's; the tests reuse the transaction
  await c.query(`select set_config('app.platform_admin_id', '', true)`);
  return r.rows[0]!.id;
}

describe('a platform session sees no customer data', () => {
  it('zero rows from stock, rosters, workers and their pay, requests; no customer audit — even with app.user_id set', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newAdmin(c);
      const owner = ids.user('test.account-owner');
      for (const table of [
        'inv.stock_ledger',
        'inv.stock_level',
        'hr.shift',
        'hr.shift_assignment',
        'hr.attendance',
        'hr.leave_balance',
        'hr.worker',
        'wf.request',
      ]) {
        const r = await asPlatform<{ n: number }>(
          c,
          admin,
          `select count(*)::int as n from ${table}`,
          [],
          owner,
        );
        expect(r.error, table).toBeUndefined();
        expect(r.rows![0]!.n, table).toBe(0);
      }
      const me = await asPlatform(c, admin, 'select * from core.me()', [], owner);
      expect(me.rows).toEqual([]);
      const audit = await asPlatform(c, admin, 'select * from core.access_audit(10)', [], owner);
      expect(audit.error).toBe('NOT_AUTHORISED');
    });
  });

  it('platform functions return customer metadata only', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newAdmin(c);
      const r = await asPlatform<Record<string, unknown>>(
        c,
        admin,
        'select * from platform.customers() order by code',
      );
      expect(r.error).toBeUndefined();
      const company = r.rows!.find((x) => x.code === 'TEST-COMPANY')!;
      expect(Object.keys(company).sort()).toEqual(
        [
          'id',
          'code',
          'name',
          'country',
          'status',
          'is_test',
          'user_count',
          'last_activity',
          'created_at',
        ].sort(),
      );
      expect(company.status).toBe('active');
      expect(Number(company.user_count)).toBeGreaterThan(50);
    });
  });
});

describe('customers cannot use the platform', () => {
  it('NOT_AUTHORISED on every platform function for a customer user, even an account owner', async () => {
    await inRolledBackTx(async (c) => {
      const owner = ids.user('test.account-owner');
      const tenant = ids.tenant('TEST-SOLO-COMPANY');
      for (const [sql, params] of [
        ['select * from platform.customers()', []],
        [`select platform.suspend($1, 'x')`, [tenant]],
        [`select platform.reactivate($1, 'x')`, [tenant]],
        [
          `select platform.request_create_customer($1::jsonb)`,
          [JSON.stringify({ code: 'ACME', name: 'Acme' })],
        ],
        ['select * from platform.jobs()', []],
        ['select * from platform.audit()', []],
      ] as const) {
        expect((await attemptAs(c, owner, sql, [...params])).error, sql).toBe('NOT_AUTHORISED');
      }
    });
  });

  it('app_rw cannot write platform tables directly', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('set local role app_rw');
      for (const sql of [
        `insert into platform.admin (cognito_sub, email) values ('x', 'x@example.test')`,
        `insert into platform.job (kind, payload) values ('create_customer', '{}')`,
        `update core.tenant set status = 'suspended'`,
      ]) {
        expect(await sqlState(c, sql), sql).toBe('42501');
      }
      await resetRole(c);
    });
  });
});

describe('suspending a customer', () => {
  it('ends sessions and sign-ins; reactivating restores them; both are audited', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newAdmin(c);
      const tenant = ids.tenant('TEST-SOLO-COMPANY');
      const owner = ids.user('test.solo.bar-manager');
      await c.query(`update core.app_user set cognito_sub = 'solo-sub' where id = $1`, [owner]);
      const signIns = async () => {
        await c.query('set local role app_rw');
        const r = await c.query<{ a: string | null; b: string | null }>(
          `select core.user_for_cognito_sub('solo-sub') as a,
                  core.user_for_username('TEST-SOLO-COMPANY', 'test.solo.bar-manager') as b`,
        );
        await resetRole(c);
        return r.rows[0]!;
      };
      const session = async () =>
        (await attemptAs(c, owner, 'select * from core.me()')).rows!.length;

      expect(await signIns()).toEqual({ a: owner, b: owner });
      expect(await session()).toBe(1);
      expect(
        (await asPlatform(c, admin, `select platform.suspend($1, 'unpaid')`, [tenant])).error,
      ).toBeUndefined();
      expect(await signIns()).toEqual({ a: null, b: null });
      expect(await session()).toBe(0);
      // RPCs refuse too
      expect((await attemptAs(c, owner, `select * from core.admin_users()`)).error).toBe(
        'NOT_AUTHORISED',
      );
      // other customers are untouched
      expect(
        (await attemptAs(c, ids.user('test.account-owner'), 'select * from core.me()')).rows!
          .length,
      ).toBe(1);

      await asPlatform(c, admin, `select platform.reactivate($1, 'paid')`, [tenant]);
      expect(await signIns()).toEqual({ a: owner, b: owner });
      expect(await session()).toBe(1);

      const audit = await asPlatform<{ action: string; reason: string }>(
        c,
        admin,
        'select action, reason from platform.audit() where tenant_id = $1 order by at',
        [tenant],
      );
      expect(audit.rows!.map((a) => [a.action, a.reason])).toEqual([
        ['suspend', 'unpaid'],
        ['reactivate', 'paid'],
      ]);
    });
  });
});

describe('the platform audit is append-only', () => {
  it('no update or delete, not even by app_rw through a platform session', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newAdmin(c);
      await asPlatform(c, admin, `select platform.suspend($1, 'x')`, [
        ids.tenant('TEST-SOLO-COMPANY'),
      ]);
      for (const sql of [
        'update platform.audit_event set reason = $1',
        'delete from platform.audit_event',
      ]) {
        await c.query('set local role app_rw');
        expect(await sqlState(c, sql, sql.startsWith('update') ? ['changed'] : []), sql).toBe(
          '42501',
        );
        await resetRole(c);
      }
      // not even the table owner, by trigger
      expect(await sqlState(c, `update platform.audit_event set reason = 'changed'`)).toBe('P0001');
      expect(await sqlState(c, 'delete from platform.audit_event')).toBe('P0001');
    });
  });
});

describe('is_test is fixed at creation', () => {
  it('set on insert, audited, and never changed afterwards', async () => {
    await inRolledBackTx(async (c) => {
      const t = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name, code, is_test) values ('Acme Test', 'ACME-TEST', true)
           returning id`,
        )
      ).rows[0]!.id;
      const logged = await c.query<{ v: string }>(
        `select after ->> 'is_test' as v from audit.log
          where table_name = 'core.tenant' and op = 'INSERT' and (after ->> 'id')::uuid = $1`,
        [t],
      );
      expect(logged.rows).toEqual([{ v: 'true' }]);
      // an unchanged value is fine; a change is refused, by the table owner too
      expect(
        await sqlState(c, `update core.tenant set is_test = true where id = $1`, [t]),
      ).toBeNull();
      expect(await sqlState(c, `update core.tenant set is_test = false where id = $1`, [t])).toBe(
        'P0001',
      );
      const msg = await c
        .query('savepoint m')
        .then(() => c.query(`update core.tenant set is_test = false where id = $1`, [t]))
        .then(() => null)
        .catch((e: Error) => e.message);
      await c.query('rollback to savepoint m');
      expect(msg).toBe('IS_TEST_IMMUTABLE');
    });
  });

  it('the same for existing customers (the test customers are flagged as test)', async () => {
    await inRolledBackTx(async (c) => {
      const flags = await c.query<{ code: string; is_test: boolean }>(
        `select code, is_test from core.tenant where code like 'TEST-%' order by code`,
      );
      expect(flags.rows.every((r) => r.is_test)).toBe(true);
      expect(
        await sqlState(c, `update core.tenant set is_test = false where code = 'TEST-COMPANY'`),
      ).toBe('P0001');
    });
  });
});

describe('platform_loader: loads data, no DDL, owns nothing', () => {
  it('cannot CREATE, ALTER or DROP', async () => {
    await inRolledBackTx(async (c) => {
      for (const sql of [
        'create table core.x (id int)',
        'create schema x',
        'create function core.x() returns int language sql as $$ select 1 $$',
        'alter table core.tenant add column x int',
        'alter table hr.worker disable row level security',
        'drop table hr.shift',
        'drop function core.can(text, text, uuid, uuid, uuid)',
        'truncate inv.stock_ledger',
      ]) {
        await c.query('set local role platform_loader');
        expect(await sqlState(c, sql), sql).toBe('42501');
        await resetRole(c);
      }
    });
  });

  it('owns no schema, table, function or type', async () => {
    const { rows } = await inRolledBackTx((c) =>
      c.query<{ n: number }>(
        `select ((select count(*) from pg_namespace where nspowner = r.oid)
              + (select count(*) from pg_class where relowner = r.oid)
              + (select count(*) from pg_proc where proowner = r.oid)
              + (select count(*) from pg_type where typowner = r.oid))::int as n
           from pg_roles r where r.rolname = 'platform_loader'`,
      ),
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('can do the loader’s work: read and write customer rows across customers', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('set local role platform_loader');
      const shifts = await c.query<{ n: number }>('select count(*)::int as n from hr.shift');
      expect(shifts.rows[0]!.n).toBeGreaterThan(0);
      await c.query(
        `insert into core.tenant (name, code, is_test) values ('Loader Probe', 'LOADER-PROBE', false)`,
      );
      await resetRole(c);
    });
  });
});
