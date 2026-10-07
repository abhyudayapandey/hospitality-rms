import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asPlatform,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  newPlatformAdmin,
  type SeedIds,
} from '../test/helpers';

// Selling by bundle (ADR 067). A bundle groups module switches; only a platform admin puts
// one in or out of a customer's plan (platform.set_bundle, audited). The Account Owner turns
// single modules off and on inside a bundle in the plan, and can't turn one on outside it
// (NOT_IN_PLAN). Existing customers have every bundle: the migration writes nothing.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const OWNER = 'test.account-owner';
const SOLO_OWNER = 'test.solo.bar-manager';

async function modules(c: PoolClient, who: string): Promise<Record<string, boolean>> {
  const r = await attemptAs<{ code: string; on: boolean }>(
    c,
    ids.user(who),
    'select code, "on" from core.my_modules()',
  );
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return Object.fromEntries(r.rows.map((m) => [m.code, m.on]));
}

async function plan(c: PoolClient, who: string): Promise<Record<string, boolean>> {
  const r = await attemptAs<{ code: string; in_plan: boolean }>(
    c,
    ids.user(who),
    'select code, in_plan from core.my_bundles()',
  );
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return Object.fromEntries(r.rows.map((b) => [b.code, b.in_plan]));
}

const setModule = (c: PoolClient, who: string, code: string, on: boolean) =>
  attemptAs(c, ids.user(who), 'select core.set_module($1, $2)', [code, on]);

const setBundle = (c: PoolClient, admin: string, tenant: string, bundle: string, on: boolean) =>
  asPlatform<{ changed: boolean }>(c, admin, 'select platform.set_bundle($1, $2, $3) as changed', [
    tenant,
    bundle,
    on,
  ]);

describe('existing customers keep what they have', () => {
  it('every bundle but Compliance is in the plan, and the modules are as file 00 left them', async () => {
    await inRolledBackTx(async (c) => {
      // Compliance is out of the plan unless the platform admin adds it (ADR 069); the dev
      // seed adds it for Test Company
      const all = { people_roster: true, stock_cost: true, tasks_food_safety: true };
      expect(await plan(c, 'test.server.3.0')).toEqual({ ...all, compliance: true });
      expect(await plan(c, 'test.solo.server')).toEqual({ ...all, compliance: false });
      const solo = await modules(c, 'test.solo.server');
      expect(Object.keys(solo).filter((k) => !solo[k])).toEqual(['compliance', 'events', 'swaps']);
      const company = await modules(c, 'test.server.3.0');
      expect(Object.values(company).every(Boolean)).toBe(true);
      const { rows } = await c.query<{ code: string; bundles: unknown }>(
        `select code, settings -> 'bundles' as bundles from core.tenant where settings ? 'bundles'`,
      );
      expect(rows).toEqual([{ code: 'TEST-COMPANY', bundles: { compliance: true } }]);
    });
  });
});

describe('only a platform admin changes the plan', () => {
  it('customers, the Account Owner included, cannot call the platform functions', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [OWNER, SOLO_OWNER, 'test.general-manager.1.0', 'test.server.3.0']) {
        for (const [sql, params] of [
          ['select * from platform.customer_modules($1)', [ids.tenant()]],
          [
            'select platform.set_bundle($1, $2, $3)',
            [ids.tenant('TEST-SOLO-COMPANY'), 'tasks_food_safety', false],
          ],
        ] as const) {
          const r = await attemptAs(c, ids.user(who), sql, [...params]);
          expect(r.error, `${who}: ${sql}`).toMatch(/NOT_AUTHORISED|permission denied/);
        }
      }
      expect(await plan(c, 'test.solo.server')).toMatchObject({ tasks_food_safety: true });
    });
  });

  it('the owner cannot write the plan through the company settings', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(c, ids.user(OWNER), 'select core.set_company_settings($1)', [
        JSON.stringify({ bundles: { tasks_food_safety: true } }),
      ]);
      expect(r.error).toMatch(/INVALID_SETTING/);
    });
  });

  it("the console reads a customer's modules by bundle", async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const r = await asPlatform<{
        bundle: string;
        module: string;
        in_plan: boolean;
        is_on: boolean;
      }>(c, admin, 'select * from platform.customer_modules($1)', [
        ids.tenant('TEST-SOLO-COMPANY'),
      ]);
      expect(r.error).toBeUndefined();
      expect(r.rows).toHaveLength(9);
      expect(r.rows!.find((m) => m.bundle === 'compliance')).toEqual({
        bundle: 'compliance',
        module: 'compliance',
        in_plan: false,
        is_on: false,
      });
      expect(r.rows!.filter((m) => m.bundle === 'people_roster')).toEqual([
        { bundle: 'people_roster', module: 'events', in_plan: true, is_on: false },
        { bundle: 'people_roster', module: 'leave', in_plan: true, is_on: true },
        { bundle: 'people_roster', module: 'swaps', in_plan: true, is_on: false },
      ]);
      const missing = await asPlatform(c, admin, 'select * from platform.customer_modules($1)', [
        '00000000-0000-7000-8000-000000000000',
      ]);
      expect(missing.error).toMatch(/NOT_FOUND/);
    });
  });

  it('a bundle out of the plan: its modules are off for everyone there, audited', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const r = await setBundle(c, admin, ids.tenant(), 'tasks_food_safety', false);
      expect(r.error).toBeUndefined();
      expect(r.rows![0]!.changed).toBe(true);
      // the same again changes nothing
      expect(
        (await setBundle(c, admin, ids.tenant(), 'tasks_food_safety', false)).rows![0]!.changed,
      ).toBe(false);

      expect(await plan(c, 'test.technician.1.0')).toEqual({
        people_roster: true,
        stock_cost: true,
        tasks_food_safety: false,
        compliance: true,
      });
      const m = await modules(c, 'test.technician.1.0');
      expect(m.checklists).toBe(false);
      expect(m.maintenance).toBe(false);
      expect(m.production).toBe(true);
      // their writes are refused as for a module turned off
      const w = await attemptAs(
        c,
        ids.user('test.technician.1.0'),
        `select core.require_module('maintenance')`,
      );
      expect(w.error).toMatch(/MODULE_OFF/);
      // the other customer is untouched
      expect((await modules(c, 'test.solo.server')).maintenance).toBe(true);

      const audit = await c.query<{ admin_id: string; action: string; detail: unknown }>(
        `select admin_id, action, detail from platform.audit_event
          where tenant_id = $1 and action like 'bundle_%' order by at desc`,
        [ids.tenant()],
      );
      expect(audit.rows).toEqual([
        { admin_id: admin, action: 'bundle_off', detail: { bundle: 'tasks_food_safety' } },
      ]);
    });
  });

  it('back in the plan: its modules are on again, even one the owner had turned off', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      expect((await setModule(c, OWNER, 'maintenance', false)).error).toBeUndefined();
      await setBundle(c, admin, ids.tenant(), 'tasks_food_safety', false);
      await setBundle(c, admin, ids.tenant(), 'tasks_food_safety', true);
      const m = await modules(c, 'test.technician.1.0');
      expect(m.checklists).toBe(true);
      expect(m.maintenance).toBe(true);
      const audit = await c.query<{ action: string }>(
        `select action from platform.audit_event
          where tenant_id = $1 and action like 'bundle_%' order by at, id`,
        [ids.tenant()],
      );
      expect(audit.rows.map((a) => a.action)).toEqual(['bundle_off', 'bundle_on']);
    });
  });

  it('refuses a bundle that does not exist, and a customer that does not exist', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      expect((await setBundle(c, admin, ids.tenant(), 'reports', false)).error).toMatch(
        /INVALID_BUNDLE/,
      );
      expect(
        (await setBundle(c, admin, '00000000-0000-7000-8000-000000000000', 'stock_cost', false))
          .error,
      ).toMatch(/NOT_FOUND/);
    });
  });
});

describe('the Account Owner inside the plan', () => {
  it('cannot switch on a module outside their bundles (NOT_IN_PLAN)', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      await setBundle(c, admin, ids.tenant('TEST-SOLO-COMPANY'), 'people_roster', false);
      const r = await setModule(c, SOLO_OWNER, 'events', true);
      expect(r.error).toMatch(/NOT_IN_PLAN/);
      expect((await setModule(c, SOLO_OWNER, 'leave', true)).error).toMatch(/NOT_IN_PLAN/);
      expect((await modules(c, 'test.solo.server')).leave).toBe(false);
      // turning one off outside the plan is harmless and allowed
      expect((await setModule(c, SOLO_OWNER, 'leave', false)).error).toBeUndefined();
    });
  });

  it('can still switch one off and on again inside a bundle that is on', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      await setBundle(c, admin, ids.tenant('TEST-SOLO-COMPANY'), 'people_roster', false);
      // Tasks & food safety is in the plan
      expect((await setModule(c, SOLO_OWNER, 'maintenance', false)).error).toBeUndefined();
      expect((await modules(c, 'test.solo.server')).maintenance).toBe(false);
      expect((await setModule(c, SOLO_OWNER, 'maintenance', true)).error).toBeUndefined();
      expect((await modules(c, 'test.solo.server')).maintenance).toBe(true);
    });
  });

  it('prep lists still need production, in the same bundle', async () => {
    await inRolledBackTx(async (c) => {
      expect((await setModule(c, OWNER, 'production', false)).error).toBeUndefined();
      const m = await modules(c, 'test.commis.1.0');
      expect(m.prep_lists).toBe(false);
    });
  });
});
