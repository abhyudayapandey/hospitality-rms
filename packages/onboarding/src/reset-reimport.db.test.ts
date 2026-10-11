import {
  asPlatform,
  closePools,
  inRolledBackTx,
  newPlatformAdmin,
} from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCustomer } from './apply';
import { readCustomerDir } from './dir';

// Start again (ADR 130): after a test customer is emptied, importing its files rebuilds it
// as a new customer: the same people, roles, items and places, nothing left over.

afterAll(closePools);

const DIR = new URL('../../../docs/onboarding/test-data/test-solo-bar-co', import.meta.url)
  .pathname;

async function asLoader<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  await c.query('set local role platform_loader');
  try {
    return await fn();
  } finally {
    await c.query('reset role');
  }
}

describe('start again, then import', () => {
  it('rebuilds the customer from its files alone', async () => {
    await inRolledBackTx(async (c) => {
      const t = (
        await c.query<{ id: string; name: string }>(
          `select id, name from core.tenant where code = 'TEST-SOLO-COMPANY'`,
        )
      ).rows[0]!;
      const counts = async () =>
        (
          await c.query<Record<string, number>>(
            `select (select count(*)::int from core.app_user where tenant_id = $1 and kind = 'human') users,
                    (select count(*)::int from hr.worker where tenant_id = $1) workers,
                    (select count(*)::int from hr.job_role where tenant_id = $1) roles,
                    (select count(*)::int from inv.item where tenant_id = $1) items,
                    (select count(*)::int from core.hierarchy_node where tenant_id = $1) places`,
            [t.id],
          )
        ).rows[0]!;
      const before = await counts();
      // something made in the app, which the files know nothing of
      await c.query(
        `insert into ops.briefing (tenant_id, org_node_id, outlet_id, business_day, part, body)
         select tenant_id, id, id, current_date, 'day', 'left over'
           from core.hierarchy_node where tenant_id = $1 and kind = 'outlet' limit 1`,
        [t.id],
      );

      const admin = await newPlatformAdmin(c);
      const reset = await asPlatform(c, admin, 'select platform.reset_test_customer($1, $2)', [
        t.id,
        t.name,
      ]);
      expect(reset.error).toBeUndefined();
      expect((await counts()).users).toBe(0);

      const files = readCustomerDir(DIR);
      const applied = await asLoader(c, () => loadCustomer(c, files, { nested: true }));
      expect(applied.issues).toEqual([]);
      expect(await counts()).toEqual(before);
      // what was made in the app is gone
      expect(
        (await c.query(`select 1 from ops.briefing where tenant_id = $1`, [t.id])).rowCount,
      ).toBe(0);
      // and the files are all there is: a second run changes nothing
      const again = await asLoader(c, () => loadCustomer(c, files, { nested: true, dryRun: true }));
      expect(Object.entries(again.counts).filter(([, n]) => n.created || n.updated)).toEqual([]);
    });
  });
});
