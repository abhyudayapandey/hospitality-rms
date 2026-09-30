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

const OWEN = () => ids.user('test.account-owner');

/** A User Admin for Test Bar 3.0 with no other access (a fixture, rolled back). */
async function outletUserAdmin(c: PoolClient): Promise<string> {
  const ua = await newWorker(c, ids, 'Una User Admin', 'TEST-BAR-3.0', 'SERVER', [
    ['USER_ADMIN', 'TEST-BAR-3.0'],
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
      // Test Company file 08: the Hotel 1.0 GM is also User Admin for Hotel 1.0 only
      const gm = ids.user('test.general-manager.1.0');
      const dir = await rows<Record<string, unknown>>(c, gm, 'select * from core.user_directory()');
      const names = dir.map((d) => d.display_name);
      expect(names).toContain('Test Bar Manager 1.0');
      expect(names).not.toContain('Test Bar Manager 1.1');
      expect(names).not.toContain('Test Bar Manager 3.0');
      expect(dir.find((d) => d.username === 'test.cook.2.0')).toBeUndefined();
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
      const tree = await rows<{ code: string }>(c, gm, 'select code from core.structure_tree()');
      const got = tree.map((t) => t.code);
      expect(got).toContain('TEST-HOTEL-1.0-BAR');
      expect(got).toContain('TEST-HOTEL-1.0-SUPPLY'); // its supply point...
      expect(got).toContain('TEST-HOTEL-1.0-KITCHEN-STORE'); // ...and the stores under it
      expect(got).not.toContain('TEST-HOTEL-1.1');
      expect(got).not.toContain('TEST-CENTRAL-KITCHEN-STORE');

      // the Guest House front desk executive administers the Guest House, nothing else
      const fd = ids.user('test.front-desk-executive.2.0');
      const fdTree = await rows<{ code: string }>(c, fd, 'select code from core.structure_tree()');
      expect(fdTree.map((t) => t.code).sort()).toEqual([
        'TEST-GUEST-HOUSE-2.0',
        'TEST-GUEST-HOUSE-2.0-SUPPLY',
      ]);
    });
  });

  it('a User Admin over the central kitchen does not reach the outlets it supplies', async () => {
    await inRolledBackTx(async (c) => {
      const ck = await newWorker(c, ids, 'Cara CK Admin', 'TEST-CENTRAL-KITCHEN', 'SERVER', [
        ['USER_ADMIN', 'TEST-CENTRAL-KITCHEN'],
      ]);
      const tree = await rows<{ code: string }>(
        c,
        ck.userId,
        `select code from core.structure_tree() where type = 'delivery'`,
      );
      expect(tree.map((t) => t.code)).toEqual(['TEST-CENTRAL-KITCHEN-STORE']);
    });
  });

  it('admin rights are not data access: no worker detail, pay, roster, stock or audit', async () => {
    await inRolledBackTx(async (c) => {
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
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
        expect.arrayContaining(['Test Server 3.0', 'Test Cook 2.0', 'Una User Admin']),
      );
    });
  });

  it('staff have no directory or structure access', async () => {
    await inRolledBackTx(async (c) => {
      await workerFor(c, ids, 'test.server.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE', 'SERVER');
      expect(
        await rows(c, ids.user('test.server.3.0'), 'select * from core.user_directory()'),
      ).toEqual([]);
      expect(
        await rows(c, ids.user('test.server.3.0'), 'select * from core.structure_tree()'),
      ).toEqual([]);
    });
  });
});

describe('receiving against a purchase order', () => {
  it('the Receiving Clerk receives a released PO but cannot create one', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, ids);
      const node = ids.node('TEST-HOTEL-1.0-MAIN-STORE');
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
      // STOCK_USER at the Main Store (job role default: STOCK_USER@main_store)
      const CLERK = ids.user('test.receiving-clerk.1.0');
      const lines = JSON.stringify([{ item_id: item, qty: 2 }]);
      const received = await attemptAs(c, CLERK, 'select inv.receive($1, $2::jsonb, $3)', [
        po,
        lines,
        'rc-1',
      ]);
      expect(received.error).toBeUndefined();
      const create = await attemptAs(
        c,
        CLERK,
        `select inv.create_po($1, $2, $3::jsonb, null, 'rc-2')`,
        [node, supplier, JSON.stringify([{ item_id: item, qty: 1, unit_cost: 10 }])],
      );
      expect(create.error).toBe('NOT_AUTHORISED');
      // the store keeper there can create one; staff and other stores' users can do neither
      expect(
        (
          await attemptAs(
            c,
            ids.user('test.store-keeper.1.0'),
            `select inv.create_po($1, $2, $3::jsonb, null, 'rc-4')`,
            [node, supplier, JSON.stringify([{ item_id: item, qty: 1, unit_cost: 10 }])],
          )
        ).error,
      ).toBeUndefined();
      for (const who of ['test.bellboy.1.0', 'test.cook.3.0']) {
        const r = await attemptAs(c, ids.user(who), 'select inv.receive($1, $2::jsonb, $3)', [
          po,
          lines,
          `rc-${who}`,
        ]);
        expect(r.error, who).toBe('NOT_AUTHORISED');
      }
    });
  });
});
