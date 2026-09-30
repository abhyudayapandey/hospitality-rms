import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { newWorker, tenantOf } from '../test/workforce';

// No assumed levels (ADR 009): geofences, wastage thresholds and transfer sources are found
// by walking up from where the person or the stock is.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function child(
  c: PoolClient,
  parent: string,
  type: 'org' | 'delivery',
  kind: string,
  code: string,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into core.hierarchy_node (tenant_id, type, kind, name, code, parent_id)
     select tenant_id, $2, $3, $4, $4, id from core.hierarchy_node where id = $1 returning id`,
    [parent, type, kind, code],
  );
  return rows[0]!.id;
}

describe('walking up the tree', () => {
  it('checks a department worker against the outlet geofence', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, ids);
      await c.query(
        `insert into hr.node_setting (tenant_id, org_node_id, latitude, longitude)
         values ($1, $2, 12.9716, 77.5946)
         on conflict (tenant_id, org_node_id) do update set latitude = 12.9716, longitude = 77.5946`,
        [tenant, ids.node('org:Outlet A')],
      );
      await c.query(`delete from hr.node_setting where org_node_id <> $1`, [
        ids.node('org:Outlet A'),
      ]);
      await child(c, ids.node('org:Outlet A'), 'org', 'department', 'WALK-A-BAR');
      const dept = (
        await c.query<{ id: string }>(
          `select id from core.hierarchy_node where code = 'WALK-A-BAR'`,
        )
      ).rows[0]!.id;
      const w = await newWorker(c, ids, 'Walk Bartender', 'org:Outlet A', 'SERVER');
      await c.query('update hr.worker set org_node_id = $2 where id = $1', [w.workerId, dept]);
      const r = await attemptAs<{ inside: boolean; flags: string[] }>(
        c,
        w.userId,
        `select inside, flags from hr.clock('in', 12.99, 77.5946, 10, null, 'online', 'walk-1')`,
      );
      expect(r.error).toBeUndefined();
      expect(r.rows![0]).toEqual({ inside: false, flags: ['outside_geofence'] });
    });
  });

  it('uses the supply point wastage threshold for its stores', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, ids);
      await c.query(
        `insert into inv.node_setting (tenant_id, delivery_node_id, wastage_approval_value)
         values ($1, $2, 750)
         on conflict (tenant_id, delivery_node_id) do update set wastage_approval_value = 750`,
        [tenant, ids.node('delivery:Outlet A')],
      );
      const store = await child(
        c,
        ids.node('delivery:Outlet A'),
        'delivery',
        'store',
        'WALK-A-BAR-STORE',
      );
      const t = await attemptAs<{ v: string }>(
        c,
        ids.user('Olivia Outlet Manager'),
        'select inv.wastage_threshold($1) as v',
        [store],
      );
      expect(t.rows![0]!.v).toBe('750.00');
      // another tenant's node gives nothing
      const other = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name) values ('Other') returning id`,
        )
      ).rows[0]!.id;
      const foreign = (
        await c.query<{ id: string }>(
          `insert into core.hierarchy_node (tenant_id, type, kind, name) values ($1, 'delivery', 'network', 'x') returning id`,
          [other],
        )
      ).rows[0]!.id;
      const f = await attemptAs<{ v: string | null }>(
        c,
        ids.user('Olivia Outlet Manager'),
        'select inv.wastage_threshold($1) as v',
        [foreign],
      );
      expect(f.rows![0]!.v).toBeNull();
    });
  });

  it('offers stores of the same supply point first, then hubs, and only stock locations', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, ids);
      const main = await child(
        c,
        ids.node('delivery:Outlet A'),
        'delivery',
        'store',
        'WALK-A-MAIN',
      );
      const kitchen = await child(
        c,
        ids.node('delivery:Outlet A'),
        'delivery',
        'store',
        'WALK-A-KITCHEN',
      );
      const item = (
        await c.query<{ id: string }>(`select id from inv.item where tenant_id = $1 limit 1`, [
          tenant,
        ])
      ).rows[0]!.id;
      for (const n of [main, kitchen]) {
        await c.query(
          `insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level) values ($1, $2, $3, 1)`,
          [tenant, item, n],
        );
      }
      // the supply point itself stops holding stock once it has stores
      await c.query(`update core.hierarchy_node set holds_stock = false where id = $1`, [
        ids.node('delivery:Outlet A'),
      ]);
      await c.query(
        `insert into core.role_assignment (tenant_id, user_id, group_id, node_id, effective_from)
         select $1, $2, id, $3, date '2026-01-01' from core.security_group
          where tenant_id = $1 and code = 'STORE_KEEPER'`,
        [tenant, ids.user('Kim Storekeeper'), kitchen],
      );
      const r = await attemptAs<{ id: string; kind: string }>(
        c,
        ids.user('Kim Storekeeper'),
        'select id, kind from inv.transfer_sources($1)',
        [kitchen],
      );
      expect(r.error).toBeUndefined();
      const got = r.rows!.map((x) => x.id);
      expect(got[0]).toBe(main);
      expect(r.rows![1]!.kind).toBe('hub');
      expect(got).not.toContain(ids.node('delivery:Outlet A'));
    });
  });
});
