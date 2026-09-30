import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { newWorker, tenantOf, workerFor } from '../test/workforce';

// Access groups (ADR 009): USER_ACCESS gives a minimal directory and the structure within
// its scope and nothing else; admin rights are not data access; a stock user receives
// goods against an existing PO but cannot create one.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const OWEN = () => ids.user('Owen Account Owner');

/** A User Admin for Outlet A only. */
async function outletUserAdmin(c: PoolClient): Promise<string> {
  const ua = await newWorker(c, ids, 'Una User Admin', 'org:Outlet A', 'SERVER', [
    ['USER_ADMIN', 'org:Outlet A'],
  ]);
  // admin only: drop the STAFF grant newWorker gives, so any data seen would be USER_ADMIN's
  await c.query(
    `delete from core.role_assignment ra using core.security_group g
      where g.id = ra.group_id and g.code = 'STAFF' and ra.user_id = $1`,
    [ua.userId],
  );
  return ua.userId;
}

async function rows<T = Record<string, unknown>>(
  c: PoolClient,
  user: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T & object>(c, user, sql, params);
  if (r.error !== undefined) throw new Error(`${sql}: ${r.error}`);
  return r.rows;
}

describe('USER_ACCESS directory and structure', () => {
  it('a User Admin sees names, job roles and homes within their outlet only', async () => {
    await inRolledBackTx(async (c) => {
      await workerFor(c, ids, 'Sam Staff', 'org:Outlet A', 'SERVER');
      await newWorker(c, ids, 'Bea Outlet B', 'org:Outlet B', 'SERVER');
      const ua = await outletUserAdmin(c);
      const dir = await rows<Record<string, unknown>>(c, ua, 'select * from core.user_directory()');
      const names = dir.map((d) => d.display_name);
      expect(names).toContain('Sam Staff');
      expect(names).not.toContain('Bea Outlet B');
      expect(Object.keys(dir[0]!).sort()).toEqual(
        [
          'display_name',
          'home_node_code',
          'home_node_id',
          'home_node_name',
          'job_role_code',
          'job_title',
          'status',
          'user_id',
          'username',
        ].sort(),
      );
      const tree = await rows<{ node_id: string }>(
        c,
        ua,
        'select node_id from core.structure_tree()',
      );
      const got = tree.map((t) => t.node_id);
      expect(got).toContain(ids.node('org:Outlet A'));
      expect(got).toContain(ids.node('delivery:Outlet A')); // linked supply point
      expect(got).not.toContain(ids.node('org:Outlet B'));
      expect(got).not.toContain(ids.node('delivery:Hub'));
    });
  });

  it('admin rights are not data access: no worker detail, pay, roster, stock or audit', async () => {
    await inRolledBackTx(async (c) => {
      const sam = await workerFor(c, ids, 'Sam Staff', 'org:Outlet A', 'SERVER');
      const ua = await outletUserAdmin(c);
      for (const who of [ua, OWEN()]) {
        for (const [table, filter] of [
          ['hr.worker', 'id = $1'],
          ['hr.worker_sensitive', 'worker_id = $1'],
          ['hr.shift_assignment', 'worker_id = $1'],
          ['hr.leave_balance', 'worker_id = $1'],
        ] as const) {
          const r = await rows(c, who, `select * from ${table} where ${filter}`, [sam]);
          expect(r, `${table} as ${who === ua ? 'user admin' : 'owner'}`).toEqual([]);
        }
        expect(await rows(c, who, 'select * from inv.stock_level')).toEqual([]);
        expect(await rows(c, who, 'select * from audit.log limit 1')).toEqual([]);
      }
      // the owner's directory covers the whole company
      const all = await rows<{ display_name: string }>(
        c,
        OWEN(),
        'select display_name from core.user_directory()',
      );
      expect(all.map((d) => d.display_name)).toEqual(
        expect.arrayContaining(['Sam Staff', 'Una User Admin']),
      );
    });
  });

  it('staff have no directory or structure access', async () => {
    await inRolledBackTx(async (c) => {
      await workerFor(c, ids, 'Sam Staff', 'org:Outlet A', 'SERVER');
      expect(await rows(c, ids.user('Sam Staff'), 'select * from core.user_directory()')).toEqual(
        [],
      );
      expect(await rows(c, ids.user('Sam Staff'), 'select * from core.structure_tree()')).toEqual(
        [],
      );
    });
  });
});

describe('receiving against a purchase order', () => {
  it('a stock user receives a released PO but cannot create one', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, ids);
      const node = ids.node('delivery:Outlet A');
      const { rows: r } = await c.query<{ item: string; supplier: string }>(
        `select n.item_id as item, s.id as supplier
           from inv.item_node n, inv.supplier s
          where n.delivery_node_id = $1 and s.tenant_id = $2 limit 1`,
        [node, tenant],
      );
      const { item, supplier } = r[0]!;
      const po = (
        await c.query<{ id: string }>(
          `insert into inv.purchase_order (tenant_id, delivery_node_id, supplier_id, status, total, released_at)
           values ($1, $2, $3, 'released', 20, now()) returning id`,
          [tenant, node, supplier],
        )
      ).rows[0]!.id;
      await c.query(
        `insert into inv.purchase_order_line (tenant_id, po_id, item_id, delivery_node_id, qty, unit_cost)
         values ($1, $2, $3, $4, 2, 10)`,
        [tenant, po, item, node],
      );
      const CASEY = ids.user('Casey Chef'); // STOCK_USER at delivery Outlet A
      const lines = JSON.stringify([{ item_id: item, qty: 2 }]);
      const received = await attemptAs(c, CASEY, 'select inv.receive($1, $2::jsonb, $3)', [
        po,
        lines,
        'rc-1',
      ]);
      expect(received.error).toBeUndefined();
      const create = await attemptAs(
        c,
        CASEY,
        `select inv.create_po($1, $2, $3::jsonb, null, 'rc-2')`,
        [node, supplier, JSON.stringify([{ item_id: item, qty: 1, unit_cost: 10 }])],
      );
      expect(create.error).toBe('NOT_AUTHORISED');
      // staff without stock access can do neither
      expect(
        (
          await attemptAs(c, ids.user('Sam Staff'), 'select inv.receive($1, $2::jsonb, $3)', [
            po,
            lines,
            'rc-3',
          ])
        ).error,
      ).toBe('NOT_AUTHORISED');
    });
  });
});
