import { join } from 'node:path';
import { attemptAs, closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCustomer } from './apply';
import { readCustomerDir } from './dir';

// Derived stock follows node_link to the linked node and the stores under it, stopping at
// a store linked elsewhere and never running down a hub into the outlets it supplies
// (ADR 009). Checked on Test Company's real shape.

afterAll(closePools);

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');

async function loaded(c: PoolClient) {
  const r = await loadCustomer(c, readCustomerDir(join(DATA, 'test-company')), { nested: true });
  expect(r.issues).toEqual([]);
  const user = async (username: string) =>
    (
      await c.query<{ id: string }>(
        `select id from core.app_user where tenant_id = $1 and username = $2`,
        [r.tenantId, username],
      )
    ).rows[0]!.id;
  /** Delivery places whose stock the user sees, and whether only through DERIVED_. */
  const stockPlaces = async (id: string) => {
    const vis = await attemptAs<{ ids: string[] }>(
      c,
      id,
      `select core.visible_nodes('STOCK_LEVELS', 'view') as ids`,
    );
    expect(vis.error).toBeUndefined();
    const { rows } = await c.query<{ code: string }>(
      `select code from core.hierarchy_node where id = any ($1) order by 1`,
      [vis.rows![0]!.ids],
    );
    return rows.map((x) => x.code);
  };
  const grant = async (id: string, group: string, node: string) =>
    c.query(
      `insert into core.role_assignment (tenant_id, user_id, group_id, node_id)
       select $1, $2, g.id, n.id from core.security_group g, core.hierarchy_node n
        where g.tenant_id = $1 and g.code = $3 and n.tenant_id = $1 and n.code = $4`,
      [r.tenantId, id, group, node],
    );
  return { user, stockPlaces, grant };
}

describe('derived stock view', () => {
  it('the area manager sees every outlet stock place and the central kitchen store', async () => {
    await inRolledBackTx(async (c) => {
      const t = await loaded(c);
      const am = await t.user('test.area-manager');
      expect(await t.stockPlaces(am)).toEqual(
        [
          'TEST-BAR-3.0-BAR-STORE',
          'TEST-BAR-3.0-KITCHEN-STORE',
          'TEST-BAR-3.0-SUPPLY',
          'TEST-CENTRAL-KITCHEN-STORE',
          'TEST-GUEST-HOUSE-2.0-SUPPLY',
          ...['1.0', '1.1'].flatMap((h) =>
            ['BAR-STORE', 'HOUSEKEEPING-STORE', 'KITCHEN-STORE', 'MAIN-STORE', 'SUPPLY'].map(
              (s) => `TEST-HOTEL-${h}-${s}`,
            ),
          ),
        ].sort(),
      );
      // view only: derived access never modifies
      const store = (
        await c.query<{ id: string }>(
          `select id from core.hierarchy_node where code = 'TEST-HOTEL-1.0-KITCHEN-STORE'`,
        )
      ).rows[0]!.id;
      const can = async (access: string) =>
        (
          await attemptAs<{ ok: boolean }>(
            c,
            am,
            `select core.can('STOCK_LEVELS', $1, null, $2) as ok`,
            [access, store],
          )
        ).rows;
      expect(await can('view')).toEqual([{ ok: true }]);
      expect(await can('modify')).toEqual([{ ok: false }]);
    });
  });

  it('a derived grant on a department reaches only its own store', async () => {
    await inRolledBackTx(async (c) => {
      const t = await loaded(c);
      const bm = await t.user('test.bartender.1.0'); // no stock access of their own
      expect(await t.stockPlaces(bm)).toEqual([]);
      await t.grant(bm, 'AREA_MANAGER', 'TEST-HOTEL-1.0-BAR');
      expect(await t.stockPlaces(bm)).toEqual(['TEST-HOTEL-1.0-BAR-STORE']);
    });
  });

  it('a derived grant on the central kitchen does not run down into the outlets', async () => {
    await inRolledBackTx(async (c) => {
      const t = await loaded(c);
      const drv = await t.user('test.delivery-driver');
      await t.grant(drv, 'AREA_MANAGER', 'TEST-CENTRAL-KITCHEN');
      expect(await t.stockPlaces(drv)).toEqual(['TEST-CENTRAL-KITCHEN-STORE']);
      const nodes = await attemptAs<{ name: string; derived: boolean }>(
        c,
        drv,
        `select name, derived from core.nodes('delivery')`,
      );
      expect(nodes.rows).toEqual([{ name: 'Test Central Kitchen – Store', derived: true }]);
    });
  });
});
