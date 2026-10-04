import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Every row opens (RPT-12, ADR 041): a dish's trend at an outlet (sold, sales, discount,
// recipe cost, margin) and a stock item's trend at a store (in, used, wasted, price paid,
// closing), by day, week or month. Each opens exactly where its report opens, and adds up
// to the report it came from.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const BUSINESS_DAY = new Date(Date.now() - 6 * 3_600_000).toLocaleDateString('en-CA', {
  timeZone: 'Asia/Kolkata',
});
const daysBefore = (n: number) => {
  const d = new Date(`${BUSINESS_DAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const FROM = daysBefore(13);

async function menuItem(c: PoolClient, code: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select m.id from menu.menu_item m where m.tenant_id = $1 and m.code = $2`,
    [ids.tenant(), code],
  );
  return rows[0]!.id;
}
async function item(c: PoolClient, sku: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select id from inv.item where tenant_id = $1 and sku = $2`,
    [ids.tenant(), sku],
  );
  return rows[0]!.id;
}

interface DishPoint {
  period: string;
  sold: string;
  sales: string;
  discount: string;
  cost: string;
  margin: string;
}
const dish = async (
  c: PoolClient,
  who: string,
  outlet: string,
  code: string,
  grain = 'day',
  from = FROM,
) =>
  attemptAs<DishPoint>(
    c,
    ids.user(who),
    `select period::text as period, sold, sales, discount, cost, margin
       from rpt.dish_trend($1, $2, $3, $4::date, $5::date)`,
    [ids.node(outlet), await menuItem(c, code), grain, from, BUSINESS_DAY],
  );

interface ItemPoint {
  period: string;
  came_in: string;
  received_value: string;
  used: string;
  used_value: string;
  wasted: string;
  wasted_value: string;
  avg_price: string | null;
  closing: string;
}
const stock = async (
  c: PoolClient,
  who: string,
  store: string,
  sku: string,
  grain = 'day',
  from = FROM,
) =>
  attemptAs<ItemPoint>(
    c,
    ids.user(who),
    `select t.*, t.period::text as period from rpt.item_trend($1, $2, $3, $4::date, $5::date) t`,
    [ids.node(store), await item(c, sku), grain, from, BUSINESS_DAY],
  );

const sum = <T>(rows: T[], k: keyof T) => rows.reduce((s, r) => s + Number(r[k]), 0);

describe("a dish's trend", () => {
  it('adds up to menu engineering over the same days, one row a day', async () => {
    await inRolledBackTx(async (c) => {
      const r = await dish(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0', 'BUTTER-NAAN');
      expect(r.error).toBeUndefined();
      expect(r.rows).toHaveLength(14);
      expect(r.rows![0]!.period).toBe(FROM);
      const me = await attemptAs<{ sold: string; revenue: string; cost: string }>(
        c,
        ids.user('test.general-manager.1.0'),
        `select sold, revenue, cost from rpt.menu_engineering($1, $2::date, $3::date) where code = 'BUTTER-NAAN'`,
        [ids.node('TEST-HOTEL-1.0'), FROM, BUSINESS_DAY],
      );
      const m = me.rows![0]!;
      expect(sum(r.rows!, 'sold')).toBeCloseTo(Number(m.sold), 3);
      expect(sum(r.rows!, 'sales')).toBeCloseTo(Number(m.revenue), 2);
      expect(sum(r.rows!, 'sold')).toBeGreaterThan(0);
      // cost per serve as menu engineering works it out (rounded to the paisa a serve)
      expect(Math.abs(sum(r.rows!, 'cost') - Number(m.cost) * Number(m.sold))).toBeLessThan(
        0.005 * Number(m.sold) + 0.1,
      );
      for (const p of r.rows!) {
        expect(Number(p.margin)).toBeCloseTo(Number(p.sales) - Number(p.cost), 2);
      }
    });
  });

  it('by week starts on Mondays, by month on the 1st', async () => {
    await inRolledBackTx(async (c) => {
      const w = await dish(
        c,
        'test.general-manager.1.0',
        'TEST-HOTEL-1.0',
        'BUTTER-NAAN',
        'week',
        daysBefore(90),
      );
      expect(w.rows!.length).toBeGreaterThanOrEqual(13);
      for (const p of w.rows!) expect(new Date(`${p.period}T00:00:00Z`).getUTCDay()).toBe(1);
      const m = await dish(
        c,
        'test.general-manager.1.0',
        'TEST-HOTEL-1.0',
        'BUTTER-NAAN',
        'month',
        daysBefore(300),
      );
      for (const p of m.rows!) expect(p.period.endsWith('-01')).toBe(true);
      expect(sum(m.rows!, 'sold')).toBeCloseTo(sum(w.rows!, 'sold'), 3);
    });
  });

  it('opens where menu engineering opens', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        (await dish(c, 'test.cost-controller.1.0', 'TEST-HOTEL-1.0', 'BUTTER-NAAN')).error,
      ).toBeUndefined();
      for (const who of [
        'test.steward.1.0',
        'test.commis.1.0',
        'test.general-manager.1.1',
        'test.solo.bar-manager',
      ]) {
        expect((await dish(c, who, 'TEST-HOTEL-1.0', 'BUTTER-NAAN')).error, who).toMatch(
          /NOT_AUTHORISED/,
        );
      }
      expect((await dish(c, 'test.cashier.3.0', 'TEST-BAR-3.0', 'MOJITO')).error).toMatch(
        /NOT_AUTHORISED/,
      );
    });
  });

  it('refuses a dish not sold there, a bad grain or too long a period', async () => {
    await inRolledBackTx(async (c) => {
      expect((await dish(c, 'test.bar-manager.3.0', 'TEST-BAR-3.0', 'DAL-TADKA')).error).toMatch(
        /INVALID_ITEM/,
      );
      expect(
        (await dish(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0', 'BUTTER-NAAN', 'hour')).error,
      ).toMatch(/INVALID_GRAIN/);
      expect(
        (
          await dish(
            c,
            'test.general-manager.1.0',
            'TEST-HOTEL-1.0',
            'BUTTER-NAAN',
            'day',
            daysBefore(420),
          )
        ).error,
      ).toMatch(/INVALID_DATES/);
    });
  });
});

describe("a stock item's trend", () => {
  it('in, used and closing add up to the ledger', async () => {
    await inRolledBackTx(async (c) => {
      const r = await stock(
        c,
        'test.executive-chef.1.0',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
        'TOMATOES',
      );
      expect(r.error).toBeUndefined();
      expect(r.rows).toHaveLength(14);
      const { rows } = await c.query<{ rec_q: string; rec_v: string; on_hand: string }>(
        `select sum(l.qty) filter (where l.movement_type = 'receipt'
                                     and ((l.occurred_at at time zone 'Asia/Kolkata') - interval '6 hours')::date >= $3::date) as rec_q,
                sum(l.qty * l.unit_cost) filter (where l.movement_type = 'receipt'
                                     and ((l.occurred_at at time zone 'Asia/Kolkata') - interval '6 hours')::date >= $3::date) as rec_v,
                sum(l.qty) as on_hand
           from inv.stock_ledger l where l.item_id = $1 and l.delivery_node_id = $2`,
        [await item(c, 'TOMATOES'), ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'), FROM],
      );
      const purchased = rows[0]!;
      expect(Number(purchased.rec_q)).toBeGreaterThan(0);
      // receipts are part of what came in
      expect(sum(r.rows!, 'came_in')).toBeGreaterThanOrEqual(Number(purchased.rec_q) - 1e-6);
      expect(sum(r.rows!, 'received_value')).toBeCloseTo(Number(purchased.rec_v), 2);
      expect(Number(r.rows!.at(-1)!.closing)).toBeCloseTo(Number(purchased.on_hand), 3);
      // the price paid shows on the days something was received
      expect(r.rows!.some((p) => p.avg_price !== null)).toBe(true);
    });
  });

  it('opens where the stock position opens', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [
        'test.executive-chef.1.0',
        'test.cost-controller.1.0',
        'test.general-manager.1.0',
      ]) {
        expect(
          (await stock(c, who, 'TEST-HOTEL-1.0-KITCHEN-STORE', 'TOMATOES')).error,
          who,
        ).toBeUndefined();
      }
      for (const who of [
        'test.commis.1.0',
        'test.steward.1.0',
        'test.executive-chef.1.1',
        'test.solo.bar-manager',
      ]) {
        expect(
          (await stock(c, who, 'TEST-HOTEL-1.0-KITCHEN-STORE', 'TOMATOES')).error,
          who,
        ).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('one store at a time', async () => {
    await inRolledBackTx(async (c) => {
      const r = await stock(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0-SUPPLY', 'TOMATOES');
      expect(r.error).toMatch(/INVALID_STORE|NOT_AUTHORISED/);
    });
  });
});
