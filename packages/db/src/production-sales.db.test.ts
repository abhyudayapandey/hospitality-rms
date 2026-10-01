import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  type Attempt,
  type SeedIds,
} from '../test/helpers';

// Production, sales and variance behaviour (ADR 015).

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const CK = 'TEST-CENTRAL-KITCHEN-STORE';
const CK_CHEF = 'test.central-kitchen-chef';
const GM = 'test.general-manager.1.0';

async function item(c: PoolClient, sku: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id where t.code = 'TEST-COMPANY' and i.sku = $1`,
    [sku],
  );
  return rows[0]!.id;
}
async function menuItem(c: PoolClient, code: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select m.id from menu.menu_item m join core.tenant t on t.id = m.tenant_id where t.code = 'TEST-COMPANY' and m.code = $1`,
    [code],
  );
  return rows[0]!.id;
}
async function level(c: PoolClient, sku: string, store: string) {
  const { rows } = await c.query<{ on_hand: string; avg_cost: string }>(
    `select on_hand, avg_cost from inv.stock_level where item_id = $1 and delivery_node_id = $2`,
    [await item(c, sku), ids.node(store)],
  );
  return { onHand: Number(rows[0]?.on_hand ?? 0), avg: Number(rows[0]?.avg_cost ?? 0) };
}
async function ok<T extends object>(r: Promise<Attempt<T>>): Promise<T> {
  const x = await r;
  if (x.error !== undefined) throw new Error(x.error);
  return x.rows[0]!;
}
const produce = async (c: PoolClient, sku: string, qty: number, actual: unknown = null) =>
  ok<{ id: string }>(
    attemptAs(c, ids.user(CK_CHEF), 'select inv.record_production($1, $2, $3, $4::jsonb) as id', [
      ids.node(CK),
      await item(c, sku),
      qty,
      actual === null ? null : JSON.stringify(actual),
    ]),
  );
const sell = async (c: PoolClient, lines: [string, number][], date = 'today') =>
  ok<{ id: string }>(
    attemptAs(
      c,
      ids.user(GM),
      `select menu.post_sales($1, ${date === 'today' ? 'current_date' : '$3::date'}, $2::jsonb) as id`,
      [
        ids.node('TEST-HOTEL-1.0'),
        JSON.stringify(
          await Promise.all(
            lines.map(async ([code, qty]) => ({ menu_item_id: await menuItem(c, code), qty })),
          ),
        ),
        ...(date === 'today' ? [] : [date]),
      ],
    ),
  );

describe('production', () => {
  it('uses the recipe scaled to the batch, takes actual quantities, and costs the batch from what it used', async () => {
    await inRolledBackTx(async (c) => {
      const tomatoes = await level(c, 'TOMATOES', CK);
      const butter = await level(c, 'BUTTER', CK);
      // half a batch (the recipe makes 4000 g); 160 g of butter actually used instead of 150
      const { id } = await produce(c, 'MAKHANI-GRAVY', 2000, [
        { ingredient_item_id: await item(c, 'BUTTER'), qty: 160 },
      ]);
      // 3000 g of tomatoes with 5 % trim, halved, in kg
      expect((await level(c, 'TOMATOES', CK)).onHand).toBeCloseTo(
        tomatoes.onHand - 3000 / 0.95 / 2 / 1000,
        6,
      );
      expect((await level(c, 'BUTTER', CK)).onHand).toBeCloseTo(butter.onHand - 0.16, 6);
      const { rows } = await c.query<{
        qty_made: string;
        batch_no: string;
        hours: string;
        unit_cost: string;
        used: string;
      }>(
        `select p.qty_made, p.batch_no, extract(epoch from p.expires_at - p.made_at) / 3600 as hours,
                p.unit_cost,
                (select sum(-l.qty * l.unit_cost) from inv.stock_ledger l
                  where l.ref_type = 'production' and l.ref_id = p.id and l.movement_type = 'production_out') as used
           from inv.production p where p.id = $1`,
        [id],
      );
      const p = rows[0]!;
      expect(Number(p.qty_made)).toBe(2000);
      expect(p.batch_no).toMatch(/^\d{8}-1$/);
      expect(Math.round(Number(p.hours))).toBe(72);
      expect(Number(p.unit_cost)).toBeCloseTo(Number(p.used) / 2000, 4);
      expect((await level(c, 'MAKHANI-GRAVY', CK)).onHand).toBe(2000);
    });
  });
});

describe('batches and expiry', () => {
  it('what is left belongs to the newest batch first; an expired one shows as expired', async () => {
    await inRolledBackTx(async (c) => {
      const gravy = await item(c, 'MAKHANI-GRAVY');
      // an old batch (expired yesterday) and a fresh one
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty, unit_cost,
                                       ref_type, batch_no, expires_at, occurred_at)
         values ($1, $2, $3, 'production_in', 1000, 0.1, 'test', 'OLD', now() - interval '1 day', now() - interval '4 days')`,
        [ids.tenant(), gravy, ids.node(CK)],
      );
      await produce(c, 'MAKHANI-GRAVY', 4000);
      // 4500 g used: all of the old batch and 3500 g of the new one
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty, ref_type)
         values ($1, $2, $3, 'consumption', -4500, 'test')`,
        [ids.tenant(), gravy, ids.node(CK)],
      );
      const { rows } = await c.query<{ batch_no: string; remaining: string }>(
        `select batch_no, remaining from inv.batch_rows($1, $2) order by expires_at`,
        [gravy, ids.node(CK)],
      );
      expect(rows.map((r) => [r.batch_no, Number(r.remaining)])).toEqual([
        ['OLD', 0],
        [expect.stringMatching(/-1$/), 500],
      ]);
      // nothing of the old batch is left, so nothing to waste
      const b = await attemptAs<{ batch_no: string; expired: boolean }>(
        c,
        ids.user(CK_CHEF),
        'select batch_no, expired from inv.batches($1)',
        [ids.node(CK)],
      );
      expect(b.rows!.map((r) => r.expired)).toEqual([false]);
    });
  });

  it('a transfer carries the expiry of the oldest batch sent', async () => {
    await inRolledBackTx(async (c) => {
      await produce(c, 'MAKHANI-GRAVY', 4000);
      const gravy = await item(c, 'MAKHANI-GRAVY');
      const ref = '01900000-0000-7000-8000-000000000001';
      for (const [store, type, qty] of [
        [CK, 'transfer_out', -1000],
        ['TEST-HOTEL-1.0-KITCHEN-STORE', 'transfer_in', 1000],
      ] as const) {
        await c.query(
          `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty, unit_cost, ref_type, ref_id)
           values ($1, $2, $3, $4, $5, 0.1, 'transfer', $6)`,
          [ids.tenant(), gravy, ids.node(store), type, qty, ref],
        );
      }
      const { rows } = await c.query<{ same: boolean }>(
        `select (select expires_at from inv.production where delivery_node_id = $1 order by made_at desc limit 1)
                = (select expires_at from inv.stock_ledger where ref_id = $2 and movement_type = 'transfer_in') as same`,
        [ids.node(CK), ref],
      );
      expect(rows[0]!.same).toBe(true);
    });
  });
});

describe('sales', () => {
  it('deplete by recipe with six decimals: a 100 ml pour is 0.133333 of a 750 ml bottle', async () => {
    await inRolledBackTx(async (c) => {
      const before = await level(c, 'SODA-750ML', 'TEST-HOTEL-1.0-BAR-STORE');
      await sell(c, [['MOJITO', 1]]);
      const after = await level(c, 'SODA-750ML', 'TEST-HOTEL-1.0-BAR-STORE');
      expect(Number((before.onHand - after.onHand).toFixed(6))).toBe(0.133333);
    });
  });

  it('a past day is posted at the end of that day; a receipt into negative stock resets the average', async () => {
    await inRolledBackTx(async (c) => {
      const yesterday = (await c.query<{ d: string }>(`select (current_date - 1)::text as d`))
        .rows[0]!.d;
      // the loader dates prices and recipes from the day it ran: date them a week back here
      await c.query(
        `update menu.menu_outlet set effective_from = effective_from - 7 where menu_item_id = $1`,
        [await menuItem(c, 'BUTTER-NAAN')],
      );
      await c.query(
        `update inv.recipe set effective_from = effective_from - 7 where menu_item_id = $1`,
        [await menuItem(c, 'BUTTER-NAAN')],
      );
      await sell(c, [['BUTTER-NAAN', 1000]], yesterday);
      const { rows } = await c.query<{ local: string }>(
        `select to_char(max(occurred_at) at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') as local
           from inv.stock_ledger where movement_type = 'sales_depletion' and item_id = $1`,
        [await item(c, 'BUTTER')],
      );
      expect(rows[0]!.local).toBe(`${yesterday} 23:59:59`);
      const neg = await level(c, 'BUTTER', 'TEST-HOTEL-1.0-KITCHEN-STORE');
      expect(neg.onHand).toBeLessThan(0);
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty, unit_cost, ref_type)
         values ($1, $2, $3, 'receipt', 20, 600, 'test')`,
        [ids.tenant(), await item(c, 'BUTTER'), ids.node('TEST-HOTEL-1.0-KITCHEN-STORE')],
      );
      expect((await level(c, 'BUTTER', 'TEST-HOTEL-1.0-KITCHEN-STORE')).avg).toBe(600);
    });
  });
});

describe('variance and cost %', () => {
  it('opening + movements − sales use = expected; the count shows the variance and flags a loss', async () => {
    await inRolledBackTx(async (c) => {
      const store = 'TEST-HOTEL-1.0-KITCHEN-STORE';
      const butter = await item(c, 'BUTTER');
      const start = (await level(c, 'BUTTER', store)).onHand;
      await sell(c, [['BUTTER-NAAN', 20]]); // 20 × 10 g = 0.2 kg
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty, unit_cost, ref_type, reason)
         values ($1, $2, $3, 'wastage', -0.1, 0, 'test', 'spoiled'),
                ($1, $2, $3, 'count_adjust', -0.5, 0, 'test', 'count_variance')`,
        [ids.tenant(), butter, ids.node(store)],
      );
      const r = await attemptAs<Record<string, string | boolean>>(
        c,
        ids.user('test.cost-controller.1.0'),
        `select * from inv.variance($1, current_date, current_date) where sku = 'BUTTER'`,
        [ids.node(store)],
      );
      const v = r.rows![0]!;
      // the opening balance was posted today by the seed, so it is a receipt in this period
      const opening = Number(v.opening) + Number(v.receipts);
      expect(opening).toBeCloseTo(start, 6);
      expect(Number(v.sales_use)).toBeCloseTo(0.2, 6);
      expect(Number(v.wastage)).toBeCloseTo(0.1, 6);
      expect(Number(v.expected_closing)).toBeCloseTo(start - 0.3, 6);
      expect(Number(v.variance_qty)).toBeCloseTo(-0.5, 6);
      expect(Number(v.closing)).toBeCloseTo(start - 0.8, 6);
      expect(Number(v.variance_value)).toBeLessThan(0);
      expect(v.unexplained).toBe(true);
    });
  });

  it('food cost % is the recipe cost of what sold over its revenue, before tax', async () => {
    await inRolledBackTx(async (c) => {
      await sell(c, [['DAL-TADKA', 10]]);
      const r = await attemptAs<{
        menu: string;
        revenue: string;
        theoretical_cost: string;
        theoretical_pct: string;
      }>(
        c,
        ids.user('test.cost-controller.1.0'),
        `select * from menu.cost_report($1, current_date, current_date)`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      const food = r.rows!.find((x) => x.menu === 'Food')!;
      expect(Number(food.revenue)).toBe(2950); // 10 × ₹295
      // Dal Tadka costs about ₹27.65 a serve at opening (standard) cost
      expect(Number(food.theoretical_cost)).toBeCloseTo(276.5, 0);
      expect(Number(food.theoretical_pct)).toBeCloseTo(9.4, 0);
    });
  });
});
