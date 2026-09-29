import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  type SeedIds,
} from '../test/helpers';

// Inventory, orders and transfers (LLD section 5 and 7, ADR 006) through the RPCs, as
// the seeded users, inside rolled-back transactions. Items, suppliers and opening stock
// are fixtures here, so the tests do not depend on the dev seed. The executor step is
// run in-transaction as wf_executor (the same SQL the TS handlers call).

const KIM = 'Kim Storekeeper';
const OLIVIA = 'Olivia Outlet Manager';
const ARIA = 'Aria Area Manager';
const HUGO = 'Hugo Hub Manager';
const CASEY = 'Casey Chef';
const SAM = 'Sam Staff';

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const node = (name: string) => ids.node(`delivery:${name}`);

interface Fixture {
  tenant: string;
  supplier: string;
  item(sku: string): string;
}

/** Items stocked at the Hub and both outlets, a supplier, and optional opening stock. */
async function fixture(
  c: PoolClient,
  items: { sku: string; tolerance?: number; par?: number }[],
): Promise<Fixture> {
  const tenant = (
    await c.query<{ id: string }>('select tenant_id as id from core.hierarchy_node where id = $1', [
      node('Hub'),
    ])
  ).rows[0]!.id;
  const supplier = (
    await c.query<{ id: string }>(
      `insert into inv.supplier (tenant_id, name) values ($1, 'Test Supplier ' || core.uuid_v7())
       returning id`,
      [tenant],
    )
  ).rows[0]!.id;
  const map = new Map<string, string>();
  for (const it of items) {
    const { rows } = await c.query<{ id: string }>(
      `insert into inv.item (tenant_id, sku, name, category, base_uom)
       values ($1, $2, 'Item ' || $2, 'Test', 'kg') returning id`,
      [tenant, it.sku],
    );
    const id = rows[0]!.id;
    map.set(it.sku, id);
    for (const n of ['Hub', 'Outlet A', 'Outlet B']) {
      await c.query(
        `insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level,
                                    count_tolerance_qty, preferred_supplier_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [tenant, id, node(n), it.par ?? 0, it.tolerance ?? 0, supplier],
      );
    }
  }
  return {
    tenant,
    supplier,
    item(sku) {
      const id = map.get(sku);
      if (!id) throw new Error(`fixture item ${sku}`);
      return id;
    },
  };
}

async function stock(
  c: PoolClient,
  f: Fixture,
  sku: string,
  at: string,
  qty: number,
  cost: number,
) {
  await c.query(
    `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                   unit_cost, ref_type)
     values ($1, $2, $3, 'receipt', $4, $5, 'opening')`,
    [f.tenant, f.item(sku), node(at), qty, cost],
  );
}

async function onHand(c: PoolClient, f: Fixture, sku: string, at: string): Promise<number> {
  const { rows } = await c.query<{ q: string }>(
    `select coalesce((select on_hand from inv.stock_level
                       where item_id = $1 and delivery_node_id = $2), 0) as q`,
    [f.item(sku), node(at)],
  );
  return Number(rows[0]!.q);
}

async function call<T = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await attemptAs<T & object>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows[0] as T;
}

async function error(c: PoolClient, who: string, text: string, params: unknown[] = []) {
  return (await attemptAs(c, ids.user(who), text, params)).error;
}

/** Runs the pending outbox rows of one request as wf_executor, like runOnce does. */
async function execute(c: PoolClient, requestId: string): Promise<string[]> {
  const { rows } = await c.query<{ id: string; handler: string }>(
    `select id, handler from wf.outbox where request_id = $1 and status = 'pending'`,
    [requestId],
  );
  for (const row of rows) {
    await c.query(
      `update wf.request set state = 'executing' where id = $1 and state = 'approved'`,
      [requestId],
    );
    await actAs(c, 'wf_executor', null);
    await c.query('select inv.execute($1, $2)', [row.handler, requestId]);
    await resetRole(c);
    await c.query('select wf.complete_outbox($1)', [row.id]);
  }
  return rows.map((r) => r.handler);
}

async function inbox(c: PoolClient, who: string): Promise<string[]> {
  const r = await attemptAs<{ request_id: string }>(
    c,
    ids.user(who),
    'select request_id from wf.my_inbox()',
  );
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows.map((x) => x.request_id);
}

async function requestOf(c: PoolClient, table: string, id: string): Promise<string> {
  const { rows } = await c.query<{ r: string }>(
    `select wf_request_id as r from inv.${table} where id = $1`,
    [id],
  );
  return rows[0]!.r;
}

async function statusOf(c: PoolClient, table: string, id: string): Promise<string> {
  const { rows } = await c.query<{ s: string }>(
    `select status as s from inv.${table} where id = $1`,
    [id],
  );
  return rows[0]!.s;
}

const lines = (l: object[]) => JSON.stringify(l);

describe('wastage', () => {
  it('posts small wastage directly and sends valuable wastage (with photo) for approval', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [{ sku: 'W-OIL' }, { sku: 'W-PRAWN' }]);
      await stock(c, f, 'W-OIL', 'Outlet A', 20, 150); // 3,000 of oil
      await stock(c, f, 'W-PRAWN', 'Outlet A', 10, 900); // 9,000 of prawns

      // 2 kg oil = 300: under the 2,000 default, posts now.
      const small = await call<{ id: string }>(
        c,
        CASEY,
        `select inv.record_wastage($1, $2::jsonb) as id`,
        [node('Outlet A'), lines([{ item_id: f.item('W-OIL'), qty: 2, reason: 'spoiled' }])],
      );
      expect(await onHand(c, f, 'W-OIL', 'Outlet A')).toBe(18);
      const posted = await c.query<{ movement_type: string; qty: string; reason: string }>(
        `select movement_type, qty, reason from inv.stock_ledger where ref_id = $1`,
        [small.id],
      );
      expect(posted.rows).toEqual([{ movement_type: 'wastage', qty: '-2.000', reason: 'spoiled' }]);

      // 3 kg prawns = 2,700: needs a photo...
      const prawns = { item_id: f.item('W-PRAWN'), qty: 3, reason: 'expired' };
      const sql = `select inv.record_wastage($1, $2::jsonb) as id`;
      expect(await error(c, KIM, sql, [node('Outlet A'), lines([prawns])])).toBe('PHOTO_REQUIRED');
      // ...uploaded under this tenant and node...
      const otherNode = `wastage/${f.tenant}/${node('Outlet B')}/${crypto.randomUUID()}.jpg`;
      expect(
        await error(c, KIM, sql, [node('Outlet A'), lines([{ ...prawns, photo_key: otherNode }])]),
      ).toBe('INVALID_PHOTO');
      // ...and then waits for the outlet manager; nothing posts yet.
      const photo = `wastage/${f.tenant}/${node('Outlet A')}/${crypto.randomUUID()}.jpg`;
      const big = await call<{ id: string }>(c, KIM, sql, [
        node('Outlet A'),
        lines([{ ...prawns, photo_key: photo }]),
      ]);
      expect(await onHand(c, f, 'W-PRAWN', 'Outlet A')).toBe(10);
      const adj = (
        await c.query<{ id: string }>('select adjustment_id as id from inv.wastage where id = $1', [
          big.id,
        ])
      ).rows[0]!.id;
      const req = await requestOf(c, 'stock_adjustment', adj);
      expect(await inbox(c, OLIVIA)).toContain(req);
      const photoOnLine = await c.query<{ photo_key: string }>(
        'select photo_key from inv.stock_adjustment_line where adjustment_id = $1',
        [adj],
      );
      expect(photoOnLine.rows).toEqual([{ photo_key: photo }]);

      await call(c, OLIVIA, `select wf.act($1, 'approve')`, [req]);
      expect(await execute(c, req)).toEqual(['inv.stock_adjustment.post']);
      expect(await statusOf(c, 'stock_adjustment', adj)).toBe('posted');
      expect(await onHand(c, f, 'W-PRAWN', 'Outlet A')).toBe(7);
    });
  });

  it('uses the per-node threshold, refuses more than on hand, and checks the node', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [{ sku: 'W-RICE' }]);
      await stock(c, f, 'W-RICE', 'Outlet A', 50, 80);
      await c.query(
        `insert into inv.node_setting (tenant_id, delivery_node_id, wastage_approval_value)
         values ($1, $2, 100)`,
        [f.tenant, node('Outlet A')],
      );
      const sql = `select inv.record_wastage($1, $2::jsonb) as id`;
      const rice = (qty: number) => lines([{ item_id: f.item('W-RICE'), qty, reason: 'damaged' }]);
      expect(await error(c, KIM, sql, [node('Outlet A'), rice(2)])).toBe('PHOTO_REQUIRED'); // 160 > 100
      expect(await error(c, KIM, sql, [node('Outlet A'), rice(1)])).toBeUndefined(); // 80
      expect(await error(c, KIM, sql, [node('Outlet A'), rice(60)])).toBe('INSUFFICIENT_STOCK');
      expect(await error(c, KIM, sql, [node('Outlet B'), rice(1)])).toBe('NOT_AUTHORISED');
      expect(await error(c, SAM, sql, [node('Outlet A'), rice(1)])).toBe('NOT_AUTHORISED');
      expect(await error(c, ARIA, sql, [node('Outlet A'), rice(1)])).toBe('NOT_AUTHORISED'); // view only
    });
  });

  it('is idempotent on the key', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [{ sku: 'W-IDEM' }]);
      await stock(c, f, 'W-IDEM', 'Outlet A', 10, 10);
      const sql = `select inv.record_wastage($1, $2::jsonb, 'w-1') as id`;
      const args = [
        node('Outlet A'),
        lines([{ item_id: f.item('W-IDEM'), qty: 1, reason: 'other' }]),
      ];
      const a = await call<{ id: string }>(c, KIM, sql, args);
      const b = await call<{ id: string }>(c, KIM, sql, args);
      expect(b.id).toBe(a.id);
      expect(await onHand(c, f, 'W-IDEM', 'Outlet A')).toBe(9);
    });
  });
});

describe('stock count variance routing', () => {
  it('posts variance within tolerance, routes the rest to approval, leaves uncounted alone', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [
        { sku: 'C-FLOUR', tolerance: 1 },
        { sku: 'C-BUTTER', tolerance: 0.5 },
        { sku: 'C-SALT', tolerance: 0 },
      ]);
      await stock(c, f, 'C-FLOUR', 'Outlet A', 20, 40);
      await stock(c, f, 'C-BUTTER', 'Outlet A', 10, 500);
      await stock(c, f, 'C-SALT', 'Outlet A', 5, 20);

      const count = await call<{ id: string }>(c, KIM, 'select inv.start_count($1) as id', [
        node('Outlet A'),
      ]);
      // an open count is resumed, not duplicated
      expect(
        (await call<{ id: string }>(c, KIM, 'select inv.start_count($1) as id', [node('Outlet A')]))
          .id,
      ).toBe(count.id);

      const summary = await call<{ s: Record<string, unknown> }>(
        c,
        KIM,
        'select inv.submit_count($1, $2::jsonb) as s',
        [
          count.id,
          lines([
            { item_id: f.item('C-FLOUR'), counted_qty: 19.2 }, // -0.8: within 1
            { item_id: f.item('C-BUTTER'), counted_qty: 8 }, // -2: beyond 0.5
          ]),
        ],
      );
      expect(summary.s).toMatchObject({ posted: 1, approval: 1 });
      expect(await onHand(c, f, 'C-FLOUR', 'Outlet A')).toBe(19.2);
      expect(await onHand(c, f, 'C-BUTTER', 'Outlet A')).toBe(10); // waits for approval
      expect(await onHand(c, f, 'C-SALT', 'Outlet A')).toBe(5); // not counted

      const adj = summary.s.adjustment_id as string;
      const req = await requestOf(c, 'stock_adjustment', adj);
      const { rows } = await c.query<{ amount: string; reason: string }>(
        'select amount, reason from inv.stock_adjustment where id = $1',
        [adj],
      );
      expect(rows).toEqual([{ amount: '1000.00', reason: 'count_variance' }]);
      // no amount tier: even this goes to the outlet manager
      expect(await inbox(c, OLIVIA)).toContain(req);
      expect(await inbox(c, KIM)).not.toContain(req);

      await call(c, OLIVIA, `select wf.act($1, 'approve')`, [req]);
      await execute(c, req);
      expect(await onHand(c, f, 'C-BUTTER', 'Outlet A')).toBe(8);
      // re-submitting returns the same summary and posts nothing more
      const again = await call<{ s: Record<string, unknown> }>(
        c,
        KIM,
        `select inv.submit_count($1, '[]'::jsonb) as s`,
        [count.id],
      );
      expect(again.s).toEqual(summary.s);
      expect(await onHand(c, f, 'C-FLOUR', 'Outlet A')).toBe(19.2);
    });
  });

  it('a rejected adjustment posts nothing', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [{ sku: 'C-MILK' }]);
      await stock(c, f, 'C-MILK', 'Outlet A', 12, 60);
      const count = await call<{ id: string }>(c, KIM, 'select inv.start_count($1) as id', [
        node('Outlet A'),
      ]);
      const s = await call<{ s: { adjustment_id: string } }>(
        c,
        KIM,
        'select inv.submit_count($1, $2::jsonb) as s',
        [count.id, lines([{ item_id: f.item('C-MILK'), counted_qty: 3 }])],
      );
      const req = await requestOf(c, 'stock_adjustment', s.s.adjustment_id);
      await call(c, OLIVIA, `select wf.act($1, 'reject')`, [req]);
      expect(await execute(c, req)).toEqual(['inv.stock_adjustment.reject']);
      expect(await statusOf(c, 'stock_adjustment', s.s.adjustment_id)).toBe('rejected');
      expect(await onHand(c, f, 'C-MILK', 'Outlet A')).toBe(12);
    });
  });
});

describe('count -> PO -> approve -> receive', () => {
  it('runs the full cycle and ends with stock matching the ledger', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [{ sku: 'P-TOMATO', par: 30, tolerance: 1 }]);
      await stock(c, f, 'P-TOMATO', 'Outlet A', 12, 40);

      // 1. Count: 11.5 on the shelf (within tolerance), posted directly.
      const count = await call<{ id: string }>(c, KIM, 'select inv.start_count($1) as id', [
        node('Outlet A'),
      ]);
      await call(c, KIM, 'select inv.submit_count($1, $2::jsonb)', [
        count.id,
        lines([{ item_id: f.item('P-TOMATO'), counted_qty: 11.5 }]),
      ]);

      // 2. Suggested order: par 30 - 11.5 on hand - 0 open = 18.5.
      const sug = await call<{ suggested_qty: string; on_hand: string }>(
        c,
        KIM,
        'select suggested_qty, on_hand from inv.suggested_order($1) where item_id = $2',
        [node('Outlet A'), f.item('P-TOMATO')],
      );
      expect(sug).toEqual({ suggested_qty: '18.500', on_hand: '11.500' });

      // 3. PO for the suggestion at 50/kg = 925: outlet approval only.
      const po = await call<{ id: string }>(
        c,
        KIM,
        `select inv.create_po($1, $2, $3::jsonb, null, 'po-1') as id`,
        [
          node('Outlet A'),
          f.supplier,
          lines([{ item_id: f.item('P-TOMATO'), qty: 18.5, unit_cost: 50 }]),
        ],
      );
      expect(await statusOf(c, 'purchase_order', po.id)).toBe('submitted');
      // open PO now counts against the suggestion
      const after = await call<{ suggested_qty: string }>(
        c,
        KIM,
        'select suggested_qty from inv.suggested_order($1) where item_id = $2',
        [node('Outlet A'), f.item('P-TOMATO')],
      );
      expect(after.suggested_qty).toBe('0.000');
      const receive = `select inv.receive($1, $2::jsonb) as id`;
      const tomato = (qty: number) => lines([{ item_id: f.item('P-TOMATO'), qty }]);
      expect(await error(c, KIM, receive, [po.id, tomato(18.5)])).toBe('INVALID_STATE');

      // 4. Olivia approves; the executor releases it.
      const req = await requestOf(c, 'purchase_order', po.id);
      expect(await inbox(c, OLIVIA)).toContain(req);
      await call(c, OLIVIA, `select wf.act($1, 'approve')`, [req]);
      expect(await execute(c, req)).toEqual(['inv.po.release']);
      expect(await statusOf(c, 'purchase_order', po.id)).toBe('released');

      // 5. Kim receives in two deliveries.
      await call(c, KIM, receive, [po.id, tomato(10)]);
      const partial = await c.query<{ progress: string }>(
        'select progress from inv.purchase_order_summary where id = $1',
        [po.id],
      );
      expect(partial.rows).toEqual([{ progress: 'partially_received' }]);
      await call(c, KIM, receive, [po.id, tomato(8.5)]);
      expect(await onHand(c, f, 'P-TOMATO', 'Outlet A')).toBe(30);

      const summary = await c.query<{ progress: string }>(
        'select progress from inv.purchase_order_summary where id = $1',
        [po.id],
      );
      expect(summary.rows).toEqual([{ progress: 'received' }]);
      const level = await c.query<{ avg_cost: string; value: string }>(
        'select avg_cost, value from inv.stock_level where item_id = $1 and delivery_node_id = $2',
        [f.item('P-TOMATO'), node('Outlet A')],
      );
      // (11.5 x 40 + 18.5 x 50) / 30
      expect(level.rows).toEqual([{ avg_cost: '46.1667', value: '1385.00' }]);

      const reconcile = await c.query<{ ledger: string; cached: string }>(
        `select (select sum(qty) from inv.stock_ledger where item_id = $1 and delivery_node_id = $2)::text as ledger,
                (select on_hand from inv.stock_level where item_id = $1 and delivery_node_id = $2)::text as cached`,
        [f.item('P-TOMATO'), node('Outlet A')],
      );
      expect(reconcile.rows).toEqual([{ ledger: '30.000', cached: '30.000' }]);
    });
  });

  it('routes a PO above 50,000 to the Area manager too, and is idempotent on its key', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [{ sku: 'P-LAMB' }]);
      const sql = `select inv.create_po($1, $2, $3::jsonb, null, 'po-big') as id`;
      const args = [
        node('Outlet A'),
        f.supplier,
        lines([{ item_id: f.item('P-LAMB'), qty: 60, unit_cost: 1000 }]),
      ];
      const po = await call<{ id: string }>(c, KIM, sql, args);
      expect((await call<{ id: string }>(c, KIM, sql, args)).id).toBe(po.id);
      const req = await requestOf(c, 'purchase_order', po.id);
      await call(c, OLIVIA, `select wf.act($1, 'approve')`, [req]);
      expect(await inbox(c, ARIA)).toContain(req);
      await call(c, ARIA, `select wf.act($1, 'approve')`, [req]);
      expect(await execute(c, req)).toEqual(['inv.po.release']);
      expect(await statusOf(c, 'purchase_order', po.id)).toBe('released');
    });
  });

  it('only people with PURCHASE_ORDERS modify at the node can order or receive', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [{ sku: 'P-EGG' }]);
      const sql = `select inv.create_po($1, $2, $3::jsonb) as id`;
      const egg = lines([{ item_id: f.item('P-EGG'), qty: 1, unit_cost: 5 }]);
      expect(await error(c, KIM, sql, [node('Outlet B'), f.supplier, egg])).toBe('NOT_AUTHORISED');
      expect(await error(c, CASEY, sql, [node('Outlet A'), f.supplier, egg])).toBe(
        'NOT_AUTHORISED',
      );
      expect(await error(c, ARIA, sql, [node('Outlet A'), f.supplier, egg])).toBe('NOT_AUTHORISED');
      expect(await error(c, HUGO, sql, [node('Outlet A'), f.supplier, egg])).toBe('NOT_AUTHORISED');
      // Aria sees Outlet A's POs through DERIVED_PURCHASE_ORDERS
      const po = await call<{ id: string }>(c, KIM, sql, [node('Outlet A'), f.supplier, egg]);
      const seen = await call<{ n: string }>(
        c,
        ARIA,
        'select count(*) as n from inv.purchase_order_summary where id = $1',
        [po.id],
      );
      expect(seen.n).toBe('1');
    });
  });
});

describe('over-receipt', () => {
  it('posts up to ordered + 5% and sends the excess to approval as supplier_excess', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [{ sku: 'R-CHICKEN' }]);
      const po = await call<{ id: string }>(
        c,
        KIM,
        `select inv.create_po($1, $2, $3::jsonb) as id`,
        [
          node('Outlet A'),
          f.supplier,
          lines([{ item_id: f.item('R-CHICKEN'), qty: 10, unit_cost: 300 }]),
        ],
      );
      const poReq = await requestOf(c, 'purchase_order', po.id);
      await call(c, OLIVIA, `select wf.act($1, 'approve')`, [poReq]);
      await execute(c, poReq);

      const gr = await call<{ id: string }>(c, KIM, 'select inv.receive($1, $2::jsonb) as id', [
        po.id,
        lines([{ item_id: f.item('R-CHICKEN'), qty: 12 }]),
      ]);
      expect(await onHand(c, f, 'R-CHICKEN', 'Outlet A')).toBe(10.5);
      const excess = await c.query<{ adj: string; qty: string; excess_qty: string }>(
        `select g.excess_adjustment_id as adj, l.qty, l.excess_qty
           from inv.goods_receipt g join inv.goods_receipt_line l on l.receipt_id = g.id
          where g.id = $1`,
        [gr.id],
      );
      expect(excess.rows[0]).toMatchObject({ qty: '10.500', excess_qty: '1.500' });
      const adj = excess.rows[0]!.adj;
      const adjRow = await c.query<{ reason: string; amount: string }>(
        'select reason, amount from inv.stock_adjustment where id = $1',
        [adj],
      );
      expect(adjRow.rows).toEqual([{ reason: 'supplier_excess', amount: '450.00' }]);

      const req = await requestOf(c, 'stock_adjustment', adj);
      await call(c, OLIVIA, `select wf.act($1, 'approve')`, [req]);
      await execute(c, req);
      expect(await onHand(c, f, 'R-CHICKEN', 'Outlet A')).toBe(12);
      const moves = await c.query<{ movement_type: string; qty: string; unit_cost: string }>(
        `select movement_type, qty, unit_cost from inv.stock_ledger
          where item_id = $1 order by qty desc`, // the capped receipt, then the excess
        [f.item('R-CHICKEN')],
      );
      expect(moves.rows).toEqual([
        { movement_type: 'receipt', qty: '10.500', unit_cost: '300.0000' },
        { movement_type: 'receipt', qty: '1.500', unit_cost: '300.0000' },
      ]);
    });
  });
});

describe('two-leg transfer', () => {
  it('posts out at dispatch and in at receipt, with the shortfall as transit_loss', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [{ sku: 'T-ONION' }, { sku: 'T-GARLIC' }]);
      await stock(c, f, 'T-ONION', 'Hub', 50, 30);
      await stock(c, f, 'T-GARLIC', 'Hub', 20, 200);

      const request = `select inv.request_transfer($1, $2, $3::jsonb, 'tr-1') as id`;
      const want = lines([
        { item_id: f.item('T-ONION'), qty: 10 },
        { item_id: f.item('T-GARLIC'), qty: 2 },
      ]);
      expect(await error(c, OLIVIA, request, [node('Hub'), node('Outlet A'), want])).toBe(
        'NOT_AUTHORISED', // no initiate right (rule 7: she approves the receipt)
      );
      const t = await call<{ id: string }>(c, KIM, request, [node('Hub'), node('Outlet A'), want]);
      const req = await requestOf(c, 'transfer', t.id);
      const progress = async () =>
        (
          await c.query<{ p: string }>(
            'select progress as p from inv.transfer_summary where id = $1',
            [t.id],
          )
        ).rows[0]!.p;
      expect(await progress()).toBe('awaiting_dispatch');

      // The generic inbox Approve cannot move stock.
      expect(await error(c, HUGO, `select wf.act($1, 'approve')`, [req])).toBe(
        'APPROVE_VIA_MODULE',
      );
      const dispatch = `select inv.dispatch_transfer($1, $2::jsonb) as s`;
      const sent = lines([{ item_id: f.item('T-ONION'), qty: 8 }]); // garlic ships as requested
      expect(await error(c, OLIVIA, dispatch, [t.id, sent])).toBe('NOT_AUTHORISED');

      await call(c, HUGO, dispatch, [t.id, sent]);
      expect(await onHand(c, f, 'T-ONION', 'Hub')).toBe(42);
      expect(await onHand(c, f, 'T-GARLIC', 'Hub')).toBe(18);
      expect(await onHand(c, f, 'T-ONION', 'Outlet A')).toBe(0);
      expect(await progress()).toBe('in_transit');

      // In transit: cannot be rejected or cancelled, only received.
      expect(await error(c, OLIVIA, `select wf.act($1, 'reject')`, [req])).toBe(
        'IRREVERSIBLE_STEP',
      );
      expect(await error(c, KIM, `select wf.act($1, 'cancel')`, [req])).toBe('IRREVERSIBLE_STEP');
      const receive = `select inv.receive_transfer($1, $2::jsonb) as s`;
      expect(
        await error(c, OLIVIA, receive, [t.id, lines([{ item_id: f.item('T-ONION'), qty: 9 }])]),
      ).toBe('INVALID_QUANTITY'); // more than dispatched
      expect(await error(c, HUGO, receive, [t.id, '[]'])).toBe('NOT_AUTHORISED');

      const r = await call<{ s: string }>(c, OLIVIA, receive, [
        t.id,
        lines([{ item_id: f.item('T-ONION'), qty: 7 }]),
      ]);
      expect(r.s).toBe('approved');
      expect(await onHand(c, f, 'T-ONION', 'Outlet A')).toBe(7);
      expect(await onHand(c, f, 'T-GARLIC', 'Outlet A')).toBe(2);

      const legs = await c.query<{
        at: string;
        movement_type: string;
        qty: string;
        reason: string | null;
        unit_cost: string;
      }>(
        `select case delivery_node_id when $2 then 'hub' else 'outlet' end as at, movement_type,
                qty, reason, unit_cost
           from inv.stock_ledger where ref_id = $1 and item_id = $3
          order by at, movement_type`, // uuid v7 ids within one millisecond are unordered
        [t.id, node('Hub'), f.item('T-ONION')],
      );
      expect(legs.rows).toEqual([
        {
          at: 'hub',
          movement_type: 'transfer_out',
          qty: '-8.000',
          reason: null,
          unit_cost: '30.0000',
        },
        {
          at: 'outlet',
          movement_type: 'transfer_in',
          qty: '8.000',
          reason: null,
          unit_cost: '30.0000',
        },
        {
          at: 'outlet',
          movement_type: 'wastage',
          qty: '-1.000',
          reason: 'transit_loss',
          unit_cost: '30.0000',
        },
      ]);

      expect(await execute(c, req)).toEqual(['inv.transfer.post']);
      expect(await statusOf(c, 'transfer', t.id)).toBe('completed');
      expect(await progress()).toBe('completed');
    });
  });

  it('a transfer rejected before dispatch moves no stock', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, [{ sku: 'T-LEMON' }]);
      await stock(c, f, 'T-LEMON', 'Hub', 5, 10);
      const t = await call<{ id: string }>(
        c,
        KIM,
        `select inv.request_transfer($1, $2, $3::jsonb) as id`,
        [node('Hub'), node('Outlet A'), lines([{ item_id: f.item('T-LEMON'), qty: 5 }])],
      );
      const req = await requestOf(c, 'transfer', t.id);
      await call(c, HUGO, `select wf.act($1, 'reject')`, [req]);
      expect(await execute(c, req)).toEqual(['inv.transfer.reject']);
      expect(await statusOf(c, 'transfer', t.id)).toBe('rejected');
      expect(await onHand(c, f, 'T-LEMON', 'Hub')).toBe(5);
    });
  });
});
