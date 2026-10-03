import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Company settings (R-4, ADR 031; PO-4, ADR 032), kept in core.tenant.settings next to the
// modules: the report targets, the menu engineering threshold, the overtime multiplier and
// whether an order sent to a supplier shows prices. Anyone in the company reads them; only
// the Account Owner (COMPANY_SETTINGS modify at the company) changes them, for their own
// company, within set ranges, and every change is in the audit log.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const DEFAULTS = {
  targets: { food: 30, drink: 22, labour: 25, prime: 60, wastage: 2, tasks: 90 },
  menu_popular_pct: 70,
  overtime_multiplier: 1,
  po_send_prices: false,
};

async function settings(c: PoolClient, who: string): Promise<typeof DEFAULTS> {
  const r = await attemptAs<{ s: typeof DEFAULTS }>(
    c,
    ids.user(who),
    'select core.company_settings() as s',
  );
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows[0]!.s;
}

const set = (c: PoolClient, who: string, value: unknown) =>
  attemptAs(c, ids.user(who), 'select core.set_company_settings($1::jsonb)', [
    JSON.stringify(value),
  ]);

describe('company settings', () => {
  it('everyone in the company reads them; with nothing set, the defaults', async () => {
    await inRolledBackTx(async (c) => {
      expect(await settings(c, 'test.server.3.0')).toEqual(DEFAULTS);
      expect(await settings(c, 'test.solo.server')).toEqual(DEFAULTS);
    });
  });

  it('the Account Owner changes them for their own company only; partial changes keep the rest; audited', async () => {
    await inRolledBackTx(async (c) => {
      const modulesOf = async (cl: PoolClient) =>
        (
          await cl.query<{ m: unknown }>(
            `select settings -> 'modules' as m from core.tenant where id = $1`,
            [ids.tenant()],
          )
        ).rows[0]!.m;
      const modulesBefore = await modulesOf(c);
      const r = await set(c, 'test.account-owner', {
        targets: { food: 28 },
        overtime_multiplier: 1.5,
        po_send_prices: true,
      });
      expect(r.error).toBeUndefined();
      expect(await settings(c, 'test.commis.1.0')).toEqual({
        ...DEFAULTS,
        targets: { ...DEFAULTS.targets, food: 28 },
        overtime_multiplier: 1.5,
        po_send_prices: true,
      });
      // the other company is untouched
      expect(await settings(c, 'test.solo.server')).toEqual(DEFAULTS);
      // the modules are untouched too
      expect((await modulesOf(c)) ?? null).toEqual(modulesBefore ?? null);
      const audit = await c.query<{ actor_id: string; changed: string[] }>(
        `select actor_id, changed_fields as changed from audit.log
          where table_name = 'core.tenant' and row_id = $1 and occurred_at >= now()
          order by occurred_at desc limit 1`,
        [ids.tenant()],
      );
      expect(audit.rows[0]!.actor_id).toBe(ids.user('test.account-owner'));
      expect(audit.rows[0]!.changed).toContain('settings');
    });
  });

  it('nobody else may: managers, HR, cost controller, staff', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [
        'test.general-manager.1.0',
        'test.area-manager',
        'test.hr-admin',
        'test.cost-controller.1.0',
        'test.security-admin',
        'test.commis.1.0',
      ]) {
        expect((await set(c, who, { targets: { food: 10 } })).error, who).toBe('NOT_AUTHORISED');
      }
      expect(await settings(c, 'test.commis.1.0')).toEqual(DEFAULTS);
    });
  });

  it('values out of range or unknown keys are refused, and nothing changes', async () => {
    await inRolledBackTx(async (c) => {
      for (const bad of [
        { targets: { food: -1 } },
        { targets: { food: 101 } },
        { targets: { food: 'thirty' } },
        { targets: { margin: 10 } },
        { menu_popular_pct: 5 },
        { menu_popular_pct: 150 },
        { overtime_multiplier: 0.5 },
        { overtime_multiplier: 4 },
        { po_send_prices: 'yes' },
        { modules: { events: false } },
        { something: 1 },
      ]) {
        expect((await set(c, 'test.account-owner', bad)).error, JSON.stringify(bad)).toBe(
          'INVALID_SETTING',
        );
      }
      expect(await settings(c, 'test.commis.1.0')).toEqual(DEFAULTS);
    });
  });
});
