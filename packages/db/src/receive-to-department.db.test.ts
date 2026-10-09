import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Receiving into the store or straight to the department that asked, with an optional expiry
// per line (GM item 14, ADR 080). Test Company's PO-4 (paneer and milk for Hotel 1.0's
// kitchen) was ordered by its Main Store and is not yet received. A line sent to the
// department is a receipt at the Main Store and a direct issue to the kitchen's store, in the
// ledger only; a line kept is a receipt at the Main Store; an expiry makes a dated batch.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const KEEPER = 'test.store-keeper.1.0';
const MAIN = 'TEST-HOTEL-1.0-MAIN-STORE';
const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN-STORE';

async function po4(c: PoolClient) {
  const r = await c.query<{ id: string }>(
    `select po.id from inv.purchase_order po
       join inv.purchase_order_line l on l.po_id = po.id
       join inv.item i on i.id = l.item_id
      where po.tenant_id = $1 and i.sku = 'PANEER' and po.status = 'released'
        and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
      limit 1`,
    [ids.tenant()],
  );
  return r.rows[0]!.id;
}

async function item(c: PoolClient, sku: string) {
  const r = await c.query<{ id: string }>(
    'select id from inv.item where sku = $1 and tenant_id = $2',
    [sku, ids.tenant()],
  );
  return r.rows[0]!.id;
}

const onHand = async (c: PoolClient, sku: string, store: string) =>
  Number(
    (
      await c.query<{ q: string }>(
        `select coalesce(sum(qty), 0) as q from inv.stock_ledger
          where item_id = $1 and delivery_node_id = $2`,
        [await item(c, sku), ids.node(store)],
      )
    ).rows[0]!.q,
  );

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('receiving straight to the department (item 14)', () => {
  it('each line says where it goes by default: the item, or the store when no department asked', async () => {
    await inRolledBackTx(async (c) => {
      const po = await po4(c);
      const r = await attemptAs<{ receive_to: string; desk_keeps: boolean; department: string }>(
        c,
        ids.user(KEEPER),
        'select receive_to, desk_keeps, department from inv.receive_defaults($1) order by 1',
        [po],
      );
      expect(r.error).toBeUndefined();
      expect(
        r.rows?.map((x) => [x.receive_to, x.desk_keeps, x.department.includes('Kitchen')]),
      ).toEqual([
        ['department', false, true],
        ['department', false, true],
      ]);
      const other = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        'select * from inv.receive_defaults($1)',
        [po],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('to the department: a receipt at the Main Store and a direct issue, with its expiry', async () => {
    await inRolledBackTx(async (c) => {
      const po = await po4(c);
      const [paneer, milk] = [await item(c, 'PANEER'), await item(c, 'MILK')];
      const before = {
        main: await onHand(c, 'PANEER', MAIN),
        kitchen: await onHand(c, 'PANEER', KITCHEN),
        milk: await onHand(c, 'MILK', KITCHEN),
      };
      const r = await attemptAs<{ id: string }>(
        c,
        ids.user(KEEPER),
        'select inv.receive_goods($1, $2::jsonb, $3) as id',
        [
          po,
          JSON.stringify([
            { item_id: paneer, qty: 5, amount: 1900, to: 'department', expires_on: inDays(4) },
            { item_id: milk, qty: 20, amount: 1200, to: 'department' },
          ]),
          'receive-dept-1',
        ],
      );
      expect(r.error).toBeUndefined();
      expect(await onHand(c, 'PANEER', MAIN)).toBe(before.main);
      expect(await onHand(c, 'PANEER', KITCHEN)).toBe(before.kitchen + 5);
      expect(await onHand(c, 'MILK', KITCHEN)).toBe(before.milk + 20);
      const ledger = await c.query<{
        store: string;
        movement_type: string;
        qty: string;
        dated: boolean;
      }>(
        `select n.code as store, l.movement_type, l.qty::text, l.expires_at is not null as dated
           from inv.stock_ledger l join core.hierarchy_node n on n.id = l.delivery_node_id
          where l.item_id = $1 and (l.ref_id = $2 or l.ref_id in (
                  select issue_id from inv.goods_receipt_line where receipt_id = $2))
          order by l.created_at, l.movement_type`,
        [paneer, r.rows![0]!.id],
      );
      const rows = ledger.rows.map((x) => [x.store, x.movement_type, Number(x.qty), x.dated]);
      expect(rows.sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
        [MAIN, 'receipt', 5, true],
        [KITCHEN, 'transfer_in', 5, true],
        [MAIN, 'transfer_out', -5, true],
      ]);
      // the kitchen's dated batch is on its expiry list
      const batch = await c.query<{ remaining: string }>(
        `select remaining::text from inv.batch_rows($1, $2) where remaining > 0 order by expires_at desc limit 1`,
        [paneer, ids.node(KITCHEN)],
      );
      expect(Number(batch.rows[0]!.remaining)).toBe(5);
      const issue = await c.query<{ kind: string; status: string }>(
        `select t.kind, t.status from inv.transfer t
           join inv.goods_receipt_line g on g.issue_id = t.id where g.receipt_id = $1 limit 1`,
        [r.rows![0]!.id],
      );
      expect(issue.rows[0]).toEqual({ kind: 'issue', status: 'completed' });
      // the ledger is only ever inserted into (rule 3)
      const updates = await c.query(
        `select 1 from audit.log where table_name = 'inv.stock_ledger' and op <> 'INSERT'`,
      );
      expect(updates.rowCount).toBe(0);
    });
  });

  it('into the store: a receipt at the Main Store, where it keeps the item', async () => {
    await inRolledBackTx(async (c) => {
      const po = await po4(c);
      const paneer = await item(c, 'PANEER');
      const notKept = await attemptAs(
        c,
        ids.user(KEEPER),
        'select inv.receive_goods($1, $2::jsonb)',
        [po, JSON.stringify([{ item_id: paneer, qty: 5, amount: 1900, to: 'store' }])],
      );
      expect(notKept.error).toMatch(/INVALID_ITEM/);
      await c.query(
        `insert into inv.item_node (tenant_id, item_id, delivery_node_id) values ($1, $2, $3)`,
        [ids.tenant(), paneer, ids.node(MAIN)],
      );
      const before = await onHand(c, 'PANEER', KITCHEN);
      const r = await attemptAs(c, ids.user(KEEPER), 'select inv.receive_goods($1, $2::jsonb)', [
        po,
        JSON.stringify([{ item_id: paneer, qty: 5, amount: 1900, to: 'store' }]),
      ]);
      expect(r.error).toBeUndefined();
      expect(await onHand(c, 'PANEER', MAIN)).toBe(5);
      expect(await onHand(c, 'PANEER', KITCHEN)).toBe(before);
    });
  });

  it('a past expiry, an unknown place to go, or the department receiving itself is refused', async () => {
    await inRolledBackTx(async (c) => {
      const po = await po4(c);
      const paneer = await item(c, 'PANEER');
      const line = (x: object) => JSON.stringify([{ item_id: paneer, qty: 5, amount: 1900, ...x }]);
      const past = await attemptAs(c, ids.user(KEEPER), 'select inv.receive_goods($1, $2::jsonb)', [
        po,
        line({ to: 'department', expires_on: inDays(-2) }),
      ]);
      expect(past.error).toMatch(/EXPIRY_PASSED/);
      const where = await attemptAs(
        c,
        ids.user(KEEPER),
        'select inv.receive_goods($1, $2::jsonb)',
        [po, line({ to: 'bar' })],
      );
      expect(where.error).toMatch(/INVALID_LINES/);
      for (const who of ['test.executive-chef.1.0', 'test.solo.bar-manager']) {
        const r = await attemptAs(c, ids.user(who), 'select inv.receive_goods($1, $2::jsonb)', [
          po,
          line({ to: 'department' }),
        ]);
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('an order a store placed for itself has no department to send to', async () => {
    await inRolledBackTx(async (c) => {
      const paneer = await item(c, 'PANEER');
      await c.query(
        `insert into inv.item_node (tenant_id, item_id, delivery_node_id) values ($1, $2, $3)`,
        [ids.tenant(), paneer, ids.node(MAIN)],
      );
      const po = await c.query<{ id: string }>(
        `insert into inv.purchase_order (tenant_id, delivery_node_id, status, ordered_at, released_at)
         values ($1, $2, 'released', now(), now()) returning id`,
        [ids.tenant(), ids.node(MAIN)],
      );
      await c.query(
        `insert into inv.purchase_order_line (tenant_id, po_id, item_id, delivery_node_id, qty, unit_cost)
         values ($1, $2, $3, $4, 5, 380)`,
        [ids.tenant(), po.rows[0]!.id, paneer, ids.node(MAIN)],
      );
      const r = await attemptAs(c, ids.user(KEEPER), 'select inv.receive_goods($1, $2::jsonb)', [
        po.rows[0]!.id,
        JSON.stringify([{ item_id: paneer, qty: 5, amount: 1900, to: 'department' }]),
      ]);
      expect(r.error).toMatch(/INVALID_LINES/);
    });
  });
});
