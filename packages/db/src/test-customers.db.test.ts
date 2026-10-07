import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The two test customers (docs/onboarding/test-data) as loaded by pnpm db:seed: each
// outlet shape works with the access its job roles derive (ADR 009), and the customers
// cannot see each other.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function can(
  c: PoolClient,
  who: string,
  domain: string,
  access: 'view' | 'modify',
  code: string,
): Promise<boolean> {
  const node = ids.node(code);
  const org = ids.type(code) === 'org';
  const r = await attemptAs<{ ok: boolean }>(
    c,
    ids.user(who),
    'select core.can($1, $2, $3, $4) as ok',
    [domain, access, org ? node : null, org ? null : node],
  );
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows[0]!.ok;
}

/** Codes of the places whose stock `who` can read (RLS on inv.stock_level). */
async function stockPlaces(c: PoolClient, who: string): Promise<string[]> {
  const r = await attemptAs<{ id: string }>(
    c,
    ids.user(who),
    'select distinct delivery_node_id as id from inv.stock_level',
  );
  if (r.error !== undefined) throw new Error(r.error);
  const { rows } = await c.query<{ code: string }>(
    'select code from core.hierarchy_node where id = any ($1) order by code',
    [r.rows.map((x) => x.id)],
  );
  return rows.map((x) => x.code);
}

describe('outlet shapes', () => {
  it('full hotel: departments, four stores; the GM sees them all, each keeper their own', async () => {
    await inRolledBackTx(async (c) => {
      const stores = [
        'TEST-HOTEL-1.0-BAR-STORE',
        'TEST-HOTEL-1.0-HOUSEKEEPING-STORE',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
        'TEST-HOTEL-1.0-MAIN-STORE',
      ];
      expect(await stockPlaces(c, 'test.general-manager.1.0')).toEqual(stores);
      expect(await stockPlaces(c, 'test.executive-chef.1.0')).toEqual([
        'TEST-HOTEL-1.0-KITCHEN-STORE',
      ]);
      expect(await stockPlaces(c, 'test.store-keeper.1.0')).toEqual(['TEST-HOTEL-1.0-MAIN-STORE']);
      // the store manager keeps the main store and sees every store of the outlet
      expect(await stockPlaces(c, 'test.purchase-manager.1.0')).toEqual(stores);
      expect(
        await can(c, 'test.purchase-manager.1.0', 'PURCHASE_ORDERS', 'modify', stores[3]!),
      ).toBe(true);
      expect(
        await can(c, 'test.purchase-manager.1.0', 'PURCHASE_ORDERS', 'modify', stores[2]!),
      ).toBe(false);
      // the F&B manager heads the Restaurant, Bar and Banquets, not the Kitchen
      const fb = 'test.fandb-manager.1.0';
      expect(await can(c, fb, 'ROSTER', 'modify', 'TEST-HOTEL-1.0-BANQUETS')).toBe(true);
      expect(await can(c, fb, 'ROSTER', 'modify', 'TEST-HOTEL-1.0-KITCHEN')).toBe(false);
    });
  });

  it('the Bar Manager of Hotel 1.0 cannot see the Kitchen Store', async () => {
    await inRolledBackTx(async (c) => {
      const bm = 'test.bar-manager.1.0';
      expect(await stockPlaces(c, bm)).toEqual(['TEST-HOTEL-1.0-BAR-STORE']);
      expect(await can(c, bm, 'STOCK_LEVELS', 'view', 'TEST-HOTEL-1.0-KITCHEN-STORE')).toBe(false);
      expect(await can(c, bm, 'STOCK_LEVELS', 'view', 'TEST-HOTEL-1.0-SUPPLY')).toBe(false);
      expect(await can(c, bm, 'STOCK_ADJUSTMENTS', 'modify', 'TEST-HOTEL-1.0-BAR-STORE')).toBe(
        true,
      );
      expect(await can(c, bm, 'ROSTER', 'modify', 'TEST-HOTEL-1.0-BAR')).toBe(true);
      expect(await can(c, bm, 'ROSTER', 'view', 'TEST-HOTEL-1.0-KITCHEN')).toBe(false);
    });
  });

  it('small hotel: no departments, stock at the supply point; the cook falls back to it', async () => {
    await inRolledBackTx(async (c) => {
      // file 99: "fallback: no store linked to their department, so the outlet's stock location"
      const { rows } = await c.query<{ code: string; note: string }>(
        `select n.code, ra.source_note as note
           from core.role_assignment ra
           join core.security_group g on g.id = ra.group_id and g.code = 'STOCK_USER'
           join core.hierarchy_node n on n.id = ra.node_id
          where ra.user_id = $1`,
        [ids.user('test.cook.2.0')],
      );
      expect(rows).toEqual([
        {
          code: 'TEST-GUEST-HOUSE-2.0-SUPPLY',
          note: "job role default (any) — fallback: no store linked to their department, so the outlet's stock location",
        },
      ]);
      expect(await stockPlaces(c, 'test.cook.2.0')).toEqual(['TEST-GUEST-HOUSE-2.0-SUPPLY']);
      expect(
        await can(c, 'test.cook.2.0', 'STOCK_ADJUSTMENTS', 'modify', 'TEST-GUEST-HOUSE-2.0-SUPPLY'),
      ).toBe(true);
      // the GM handles stock (no Store Keeper) and everyone reports to them
      expect(await stockPlaces(c, 'test.general-manager.2.0')).toEqual([
        'TEST-GUEST-HOUSE-2.0-SUPPLY',
      ]);
      expect(
        await can(
          c,
          'test.general-manager.2.0',
          'PURCHASE_ORDERS',
          'modify',
          'TEST-GUEST-HOUSE-2.0-SUPPLY',
        ),
      ).toBe(true);
      expect(
        await can(c, 'test.general-manager.2.0', 'ROSTER', 'modify', 'TEST-GUEST-HOUSE-2.0'),
      ).toBe(true);
    });
  });

  it('standalone bar: the Bar Manager is the outlet head; its keepers keep their stores', async () => {
    await inRolledBackTx(async (c) => {
      const bm = 'test.bar-manager.3.0';
      expect(await stockPlaces(c, bm)).toEqual([
        'TEST-BAR-3.0-BAR-STORE',
        'TEST-BAR-3.0-KITCHEN-STORE',
      ]);
      for (const dept of [
        'TEST-BAR-3.0-BAR',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'TEST-BAR-3.0-KITCHEN',
      ]) {
        expect(await can(c, bm, 'ROSTER', 'modify', dept), dept).toBe(true);
      }
      // Test Company's head bartender uses the Bar Store; ordering is the manager's
      const hb = 'test.head-bartender.3.0';
      expect(await can(c, hb, 'STOCK_ADJUSTMENTS', 'modify', 'TEST-BAR-3.0-BAR-STORE')).toBe(true);
      expect(await can(c, hb, 'PURCHASE_ORDERS', 'modify', 'TEST-BAR-3.0-BAR-STORE')).toBe(false);
    });
  });

  it('central kitchen: its manager runs the store only, and sees what it supplies', async () => {
    await inRolledBackTx(async (c) => {
      const ckm = 'test.central-kitchen-manager';
      expect(await can(c, ckm, 'TRANSFERS', 'modify', 'TEST-CENTRAL-KITCHEN-STORE')).toBe(true);
      expect(await can(c, ckm, 'TRANSFERS', 'modify', 'TEST-GUEST-HOUSE-2.0-SUPPLY')).toBe(false);
      expect(await can(c, ckm, 'STOCK_LEVELS', 'view', 'TEST-GUEST-HOUSE-2.0-SUPPLY')).toBe(true);
      // the production supervisor runs the site's people, not the outlets
      const sup = 'test.central-kitchen-supervisor';
      expect(await can(c, sup, 'ROSTER', 'modify', 'TEST-CENTRAL-KITCHEN-PRODUCTION')).toBe(true);
      expect(await can(c, sup, 'ROSTER', 'view', 'TEST-BAR-3.0')).toBe(false);
    });
  });

  it('solo bar: the owner runs the bar and owns the account; the head bartender orders', async () => {
    await inRolledBackTx(async (c) => {
      const owner = 'test.solo.bar-manager';
      expect(await can(c, owner, 'ROSTER', 'modify', 'TEST-SOLO-BAR-KITCHEN')).toBe(true);
      expect(await can(c, owner, 'USER_ACCESS', 'modify', 'TEST-SOLO-COMPANY')).toBe(true);
      expect(await stockPlaces(c, owner)).toEqual([
        'TEST-SOLO-BAR-BAR-STORE',
        'TEST-SOLO-BAR-KITCHEN-STORE',
      ]);
      // job-role access is per customer: here the Head Bartender is a STORE_KEEPER
      const hb = 'test.solo.head-bartender';
      expect(await can(c, hb, 'PURCHASE_ORDERS', 'modify', 'TEST-SOLO-BAR-BAR-STORE')).toBe(true);
      expect(await can(c, hb, 'PURCHASE_ORDERS', 'modify', 'TEST-SOLO-BAR-KITCHEN-STORE')).toBe(
        false,
      );
    });
  });
});

describe('isolation between customers', () => {
  it('no one in one customer sees the other customer’s people, places or stock', async () => {
    await inRolledBackTx(async (c) => {
      const solo = ids.tenant('TEST-SOLO-COMPANY');
      const company = ids.tenant('TEST-COMPANY');
      const tenantsOf = async (who: string, sql: string) => {
        const r = await attemptAs<{ id: string }>(c, ids.user(who), sql);
        if (r.error !== undefined) throw new Error(r.error);
        const { rows } = await c.query<{ t: string }>(
          `select distinct tenant_id as t from core.app_user where id = any ($1)
           union select distinct tenant_id from core.hierarchy_node where id = any ($1)`,
          [r.rows.map((x) => x.id)],
        );
        return rows.map((x) => x.t);
      };
      // account owners: whole-company directories and trees, each their own
      for (const [who, own] of [
        ['test.account-owner', company],
        ['test.solo.bar-manager', solo],
      ] as const) {
        expect(await tenantsOf(who, 'select user_id as id from core.user_directory()')).toEqual([
          own,
        ]);
        expect(await tenantsOf(who, 'select node_id as id from core.structure_tree()')).toEqual([
          own,
        ]);
      }
      // stock and people records, through RLS
      expect(await stockPlaces(c, 'test.area-manager')).not.toContain('TEST-SOLO-BAR-BAR-STORE');
      expect(await stockPlaces(c, 'test.solo.bar-manager')).not.toContain('TEST-BAR-3.0-BAR-STORE');
      for (const [who, table] of [
        ['test.hr-admin', 'hr.worker'],
        ['test.solo.bar-manager', 'hr.worker'],
        ['test.auditor', 'audit.log'],
      ] as const) {
        const r = await attemptAs<{ tenant_id: string }>(
          c,
          ids.user(who),
          `select distinct tenant_id from ${table}`,
        );
        const own = who.startsWith('test.solo.') ? solo : company;
        expect(
          r.rows!.map((x) => x.tenant_id),
          `${who} ${table}`,
        ).toEqual([own]);
      }
      // grants never cross: a company-wide HR admin has nothing at the solo bar
      expect(await can(c, 'test.hr-admin', 'WORKERS', 'view', 'TEST-SOLO-BAR')).toBe(false);
      expect(await can(c, 'test.solo.bar-manager', 'ROSTER', 'view', 'TEST-BAR-3.0')).toBe(false);
    });
  });
});
