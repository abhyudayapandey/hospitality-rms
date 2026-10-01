import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  sqlState,
  type SeedIds,
} from '../test/helpers';

// Test-only activity (Prompt 10b, ADR 017). The onboarding loader records the test
// customers' past batches through inv.record_test_production, which takes the batch time.
//  * It refuses any customer that isn't a test customer (is_test, fixed at creation).
//  * The app can't call it, or the batch-time body behind it: app_rw has no execute.
//  * It still checks who may produce where, like inv.record_production.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const RECORD = 'select inv.record_test_production($1, $2, $3, $4) as id';

async function prep(c: PoolClient, sku: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select id from inv.item where tenant_id = $1 and sku = $2`,
    [ids.tenant(), sku],
  );
  return rows[0]!.id;
}

/** As the loader does it: the migrator (or platform_loader) acting as a person. */
async function asLoader<T>(c: PoolClient, userId: string, fn: () => Promise<T>): Promise<T> {
  await c.query(`select set_config('app.user_id', $1, true)`, [userId]);
  try {
    return await fn();
  } finally {
    await resetRole(c);
  }
}

async function attempt(c: PoolClient, sql: string, params: unknown[]): Promise<string | null> {
  await c.query('savepoint a');
  try {
    await c.query(sql, params);
    await c.query('release savepoint a');
    return null;
  } catch (e) {
    await c.query('rollback to savepoint a');
    return (e as Error).message;
  }
}

describe('inv.record_test_production: test customers only', () => {
  it('refuses a customer that is not a test customer', async () => {
    await inRolledBackTx(async (c) => {
      const t = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name, code, is_test) values ('Real Hotels', 'REAL-HOTELS', false)
           returning id`,
        )
      ).rows[0]!.id;
      const u = (
        await c.query<{ id: string }>(
          `insert into core.app_user (tenant_id, kind, display_name, username)
           values ($1, 'human', 'Real Chef', 'real.chef') returning id`,
          [t],
        )
      ).rows[0]!.id;
      const err = await asLoader(c, u, () =>
        attempt(c, RECORD, [
          ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'),
          '00000000-0000-0000-0000-000000000000',
          100,
          new Date(Date.now() - 86_400_000),
        ]),
      );
      expect(err).toBe('TEST_CUSTOMER_ONLY');
      expect(
        (await c.query(`select 1 from inv.production where tenant_id = $1`, [t])).rowCount,
      ).toBe(0);
    });
  });

  it('records a past batch for a test customer, at that time, with its expiry', async () => {
    await inRolledBackTx(async (c) => {
      const mint = await prep(c, 'MINT-CHUTNEY');
      const at = new Date(Date.now() - 5 * 86_400_000);
      const id = await asLoader(
        c,
        ids.user('test.commis.1.0'),
        async () =>
          (
            await c.query<{ id: string }>(RECORD, [
              ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'),
              mint,
              500,
              at,
            ])
          ).rows[0]!.id,
      );
      const p = (
        await c.query<{ made_at: Date; expires_at: Date; batch_no: string; created_by: string }>(
          `select made_at, expires_at, batch_no, created_by from inv.production where id = $1`,
          [id],
        )
      ).rows[0]!;
      expect(p.made_at.getTime()).toBe(at.getTime());
      expect(p.expires_at.getTime()).toBe(at.getTime() + 48 * 3_600_000); // shelf life 48 h
      expect(p.created_by).toBe(ids.user('test.commis.1.0'));
      const local = at.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replace(/-/g, '');
      expect(p.batch_no.startsWith(`${local}-`)).toBe(true);
      // every ledger row of the batch is at the batch time
      const times = await c.query<{ t: Date }>(
        `select distinct occurred_at as t from inv.stock_ledger
          where ref_type = 'production' and ref_id = $1`,
        [id],
      );
      expect(times.rows.map((r) => r.t.getTime())).toEqual([at.getTime()]);
    });
  });

  it('still checks who may produce where, and refuses a future time', async () => {
    await inRolledBackTx(async (c) => {
      const mint = await prep(c, 'MINT-CHUTNEY');
      const past = new Date(Date.now() - 86_400_000);
      // a kitchen steward has no PRODUCTION_TEAM (file 06)
      expect(
        await asLoader(c, ids.user('test.kitchen-steward.1.0'), () =>
          attempt(c, RECORD, [ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'), mint, 500, past]),
        ),
      ).toBe('NOT_AUTHORISED');
      expect(
        await asLoader(c, ids.user('test.commis.1.0'), () =>
          attempt(c, RECORD, [
            ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'),
            mint,
            500,
            new Date(Date.now() + 3_600_000),
          ]),
        ),
      ).toBe('INVALID_DATE');
    });
  });

  it('the app cannot call it, or the batch-time body behind it', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`set local role app_rw`);
      await c.query(`select set_config('app.user_id', $1, true)`, [ids.user('test.commis.1.0')]);
      const args = [
        ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'),
        '00000000-0000-0000-0000-000000000000',
        1,
        new Date(),
      ];
      expect(await sqlState(c, RECORD, args)).toBe('42501'); // insufficient_privilege
      expect(
        await sqlState(c, 'select inv.record_production_at($1, $2, $3, null, null, $4)', args),
      ).toBe('42501');
      await resetRole(c);
    });
  });
});
