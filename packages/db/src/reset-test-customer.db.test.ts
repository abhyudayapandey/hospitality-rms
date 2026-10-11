import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asPlatform,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  newPlatformAdmin,
  type SeedIds,
} from '../test/helpers';

// Start again (ADR 130): a platform admin empties a test customer completely, keeping only the
// customer itself, then imports its current files as for a new one. Refused for a real
// customer and unless its name is typed; another customer is never touched.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const SOLO = 'TEST-SOLO-COMPANY';

describe('platform.reset_test_customer', () => {
  it("empties a test customer's every table, and nothing of anyone else's", async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const tenant = (
        await c.query<{ id: string; name: string }>(
          `select id, name from core.tenant where code = $1`,
          [SOLO],
        )
      ).rows[0]!;
      // every customer table, and how many rows each customer has in it
      const tables = (
        await c.query<{ t: string }>(
          `select format('%I.%I', n.nspname, c.relname) t
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relkind in ('r', 'p') and not c.relispartition
              and n.nspname not in ('pg_catalog', 'information_schema', 'platform', 'public')
              and not (n.nspname = 'core' and c.relname = 'tenant')
              and exists (select 1 from pg_attribute a where a.attrelid = c.oid
                             and a.attname = 'tenant_id' and not a.attisdropped)`,
        )
      ).rows.map((r) => r.t);
      const rows = async (code: string) => {
        let n = 0;
        for (const t of tables) {
          const r = await c.query<{ n: number }>(
            `select count(*)::int n from ${t} where tenant_id = (select id from core.tenant where code = $1)`,
            [code],
          );
          n += r.rows[0]!.n;
        }
        return n;
      };
      const others = await rows('TEST-COMPANY');
      expect(await rows(SOLO)).toBeGreaterThan(100);

      // the name must be typed
      expect(
        (await asPlatform(c, admin, `select platform.reset_test_customer($1, 'Solo')`, [tenant.id]))
          .error,
      ).toMatch(/CONFIRM_NAME/);
      // a customer user can't
      expect(
        (
          await asPlatform(
            c,
            '00000000-0000-0000-0000-000000000000',
            `select platform.reset_test_customer($1, $2)`,
            [tenant.id, tenant.name],
          )
        ).error,
      ).toMatch(/NOT_AUTHORISED/);

      const done = await asPlatform<{ n: number }>(
        c,
        admin,
        `select platform.reset_test_customer($1, $2) as n`,
        [tenant.id, tenant.name],
      );
      expect(done.error).toBeUndefined();
      expect(done.rows![0]!.n).toBeGreaterThan(100);
      expect(await rows(SOLO)).toBe(0);
      // the customer itself stays, with its plan; Test Company is untouched
      expect((await c.query(`select 1 from core.tenant where id = $1`, [tenant.id])).rowCount).toBe(
        1,
      );
      expect(await rows('TEST-COMPANY')).toBe(others);
      // every guard is back on
      const off = await c.query<{ t: string }>(
        `select tgrelid::regclass::text t from pg_trigger where not tgisinternal and tgenabled = 'D'`,
      );
      expect(off.rows).toEqual([]);
      // the console's record says who started it again
      const log = await c.query<{ action: string }>(
        `select action from platform.audit_event where tenant_id = $1 order by at desc limit 1`,
        [tenant.id],
      );
      expect(log.rows[0]!.action).toBe('customer_reset');
      // a Test Company user still works
      expect(ids.user('test.general-manager.1.0')).toBeTruthy();
    });
  });

  it('is refused for a real customer', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const real = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name, code, is_test) values ('Real Co', 'REAL-CO-RESET', false)
           returning id`,
        )
      ).rows[0]!;
      expect(
        (
          await asPlatform(c, admin, `select platform.reset_test_customer($1, 'Real Co')`, [
            real.id,
          ])
        ).error,
      ).toMatch(/REAL_CUSTOMER/);
    });
  });
});
