import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Production, sales and cost control (Prompt 9b, ADR 015): who may record a batch, post a
// day's sales and read the variance; sales are the only movement that may take stock below
// zero, and that never blocks a sale but tells the store's store keeper.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function item(c: PoolClient, sku: string, customer = 'TEST-COMPANY'): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id where t.code = $1 and i.sku = $2`,
    [customer, sku],
  );
  return rows[0]!.id;
}
async function menuItem(c: PoolClient, code: string, customer = 'TEST-COMPANY'): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select m.id from menu.menu_item m join core.tenant t on t.id = m.tenant_id where t.code = $1 and m.code = $2`,
    [customer, code],
  );
  return rows[0]!.id;
}
async function onHand(c: PoolClient, sku: string, store: string): Promise<number> {
  const { rows } = await c.query<{ q: string }>(
    `select coalesce(sum(qty), 0) as q from inv.stock_ledger where item_id = $1 and delivery_node_id = $2`,
    [await item(c, sku), ids.node(store)],
  );
  return Number(rows[0]!.q);
}
const today = () => new Date().toISOString().slice(0, 10);

const produce = async (
  c: PoolClient,
  who: string,
  store: string,
  sku: string,
  qty: number,
  key?: string,
) =>
  attemptAs<{ id: string }>(
    c,
    ids.user(who),
    'select inv.record_production($1, $2, $3, null, $4) as id',
    [ids.node(store), await item(c, sku), qty, key ?? null],
  );
const sell = async (
  c: PoolClient,
  who: string,
  outlet: string,
  lines: { code: string; qty: number }[],
  key?: string,
  customer = 'TEST-COMPANY',
) =>
  attemptAs<{ id: string }>(
    c,
    ids.user(who),
    'select menu.post_sales($1, $2::date, $3::jsonb, $4, $5) as id',
    [
      ids.node(outlet),
      today(),
      JSON.stringify(
        await Promise.all(
          lines.map(async (l) => ({
            menu_item_id: await menuItem(c, l.code, customer),
            qty: l.qty,
          })),
        ),
      ),
      'manual',
      key ?? null,
    ],
  );

describe('production', () => {
  it('is recorded by stock users at a store that makes the item, nowhere else', async () => {
    await inRolledBackTx(async (c) => {
      // a chef de partie (stock user at the hotel kitchen) makes ginger garlic paste there
      const own = await produce(
        c,
        'test.chef-de-partie.1.0',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
        'GINGER-GARLIC-PASTE',
        1000,
      );
      expect(own.error).toBeUndefined();
      const ok = await produce(
        c,
        'test.central-kitchen-chef',
        'TEST-CENTRAL-KITCHEN-STORE',
        'MAKHANI-GRAVY',
        4000,
      );
      expect(ok.error).toBeUndefined();
      // the hotel kitchen receives Makhani Gravy by transfer: it is not made there
      const notMade = await produce(
        c,
        'test.executive-chef.1.0',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
        'MAKHANI-GRAVY',
        4000,
      );
      expect(notMade.error).toMatch(/NOT_MADE_HERE/);
      // a store the person has no stock access at (the next hotel's kitchen)
      const elsewhere = await produce(
        c,
        'test.chef-de-partie.1.0',
        'TEST-HOTEL-1.1-KITCHEN-STORE',
        'GINGER-GARLIC-PASTE',
        1000,
      );
      expect(elsewhere.error).toMatch(/NOT_AUTHORISED/);
      // staff without stock access, cost controllers (view) and the AI agent
      for (const who of ['test.central-kitchen-commis', 'test.cost-controller.1.0', 'ai-agent']) {
        const r = await produce(
          c,
          who,
          'TEST-HOTEL-1.0-KITCHEN-STORE',
          'GINGER-GARLIC-PASTE',
          1000,
        );
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('never takes an ingredient below zero, and posts nothing when one is short', async () => {
    await inRolledBackTx(async (c) => {
      const before = await onHand(c, 'TOMATOES', 'TEST-CENTRAL-KITCHEN-STORE');
      // a hundred batches need far more tomatoes than the store holds
      const r = await produce(
        c,
        'test.central-kitchen-chef',
        'TEST-CENTRAL-KITCHEN-STORE',
        'MAKHANI-GRAVY',
        400_000,
      );
      expect(r.error).toMatch(/INSUFFICIENT_STOCK/);
      expect(await onHand(c, 'TOMATOES', 'TEST-CENTRAL-KITCHEN-STORE')).toBe(before);
      expect(await onHand(c, 'MAKHANI-GRAVY', 'TEST-CENTRAL-KITCHEN-STORE')).toBe(0);
    });
  });

  it('is idempotent: the same key records one batch', async () => {
    await inRolledBackTx(async (c) => {
      const a = await produce(
        c,
        'test.central-kitchen-chef',
        'TEST-CENTRAL-KITCHEN-STORE',
        'MAKHANI-GRAVY',
        4000,
        'k1',
      );
      const b = await produce(
        c,
        'test.central-kitchen-chef',
        'TEST-CENTRAL-KITCHEN-STORE',
        'MAKHANI-GRAVY',
        4000,
        'k1',
      );
      expect(b.rows![0]!.id).toBe(a.rows![0]!.id);
      expect(await onHand(c, 'MAKHANI-GRAVY', 'TEST-CENTRAL-KITCHEN-STORE')).toBe(4000);
    });
  });

  it('batches are read with stock access at the store only', async () => {
    await inRolledBackTx(async (c) => {
      await produce(
        c,
        'test.central-kitchen-chef',
        'TEST-CENTRAL-KITCHEN-STORE',
        'MAKHANI-GRAVY',
        4000,
      );
      const own = await attemptAs(
        c,
        ids.user('test.central-kitchen-chef'),
        'select * from inv.batches($1)',
        [ids.node('TEST-CENTRAL-KITCHEN-STORE')],
      );
      expect(own.rows!.length).toBe(1);
      const other = await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        'select * from inv.batches($1)',
        [ids.node('TEST-CENTRAL-KITCHEN-STORE')],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
      const rows = await attemptAs<{ n: number }>(
        c,
        ids.user('test.executive-chef.1.0'),
        'select count(*)::int as n from inv.production where delivery_node_id = $1',
        [ids.node('TEST-CENTRAL-KITCHEN-STORE')],
      );
      expect(rows.rows![0]!.n).toBe(0);
    });
  });
});

describe('sales', () => {
  it('are posted by the outlet manager and cost controller of the outlet only', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of ['test.general-manager.1.0', 'test.cost-controller.1.0']) {
        const r = await sell(c, who, 'TEST-HOTEL-1.0', [{ code: 'DAL-TADKA', qty: 1 }]);
        expect(r.error, who).toBeUndefined();
      }
      expect(
        (
          await sell(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.1', [
            { code: 'DAL-TADKA', qty: 1 },
          ])
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
      for (const who of [
        'test.bartender.1.0',
        'test.store-keeper.1.0',
        'test.executive-chef.1.0',
        'test.area-manager',
        'ai-agent',
      ]) {
        const r = await sell(c, who, 'TEST-HOTEL-1.0', [{ code: 'DAL-TADKA', qty: 1 }]);
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
      }
      // another customer's outlet
      const solo = await sell(
        c,
        'test.solo.bar-manager',
        'TEST-HOTEL-1.0',
        [{ code: 'MOJITO', qty: 1 }],
        undefined,
        'TEST-SOLO-COMPANY',
      );
      expect(solo.error).toMatch(/NOT_AUTHORISED|TENANT_MISMATCH/);
    });
  });

  it('may take stock below zero, never block, and tell the store’s store keeper', async () => {
    await inRolledBackTx(async (c) => {
      const before = await onHand(c, 'BUTTER', 'TEST-HOTEL-1.0-KITCHEN-STORE');
      // Butter Naan uses butter; sell far more than the store holds
      const r = await sell(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0', [
        { code: 'BUTTER-NAAN', qty: 5000 },
      ]);
      expect(r.error).toBeUndefined();
      const after = await onHand(c, 'BUTTER', 'TEST-HOTEL-1.0-KITCHEN-STORE');
      expect(after).toBeLessThan(0);
      expect(after).toBeLessThan(before);
      const { rows } = await c.query<{ n: number }>(
        `select count(*)::int as n from ops.notification
          where owner_user_id = $1 and kind = 'negative_stock' and created_at >= now() - interval '1 minute'`,
        [ids.user('test.executive-chef.1.0')],
      );
      expect(rows[0]!.n).toBeGreaterThan(0);
    });
  });

  it('every other movement still refuses to go below zero, even where sales went negative', async () => {
    await inRolledBackTx(async (c) => {
      await sell(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0', [
        { code: 'BUTTER-NAAN', qty: 5000 },
      ]);
      const butter = await item(c, 'BUTTER');
      const store = ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
      for (const type of ['wastage', 'consumption', 'transfer_out', 'production_out']) {
        await c.query('savepoint s');
        await expect(
          c.query(
            `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty, unit_cost, ref_type)
             values ($1, $2, $3, $4, -0.001, 1, 'test')`,
            [ids.tenant(), butter, store, type],
          ),
          type,
        ).rejects.toThrow('INSUFFICIENT_STOCK');
        await c.query('rollback to savepoint s');
      }
    });
  });

  it('are idempotent per key, and a day posted again moves stock by the difference only', async () => {
    await inRolledBackTx(async (c) => {
      const store = 'TEST-HOTEL-1.0-KITCHEN-STORE';
      const start = await onHand(c, 'BUTTER', store);
      const a = await sell(
        c,
        'test.general-manager.1.0',
        'TEST-HOTEL-1.0',
        [{ code: 'BUTTER-NAAN', qty: 10 }],
        'day-1',
      );
      const b = await sell(
        c,
        'test.general-manager.1.0',
        'TEST-HOTEL-1.0',
        [{ code: 'BUTTER-NAAN', qty: 10 }],
        'day-1',
      );
      expect(b.rows![0]!.id).toBe(a.rows![0]!.id);
      const once = await onHand(c, 'BUTTER', store);
      // the corrected day: 12, not 10 + 12
      await sell(
        c,
        'test.general-manager.1.0',
        'TEST-HOTEL-1.0',
        [{ code: 'BUTTER-NAAN', qty: 12 }],
        'day-1b',
      );
      const twice = await onHand(c, 'BUTTER', store);
      expect((start - twice) / (start - once)).toBeCloseTo(1.2, 6);
    });
  });

  it('only manual entry and the POS import post sales', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        'select menu.post_sales($1, $2::date, $3::jsonb, $4)',
        [
          ids.node('TEST-HOTEL-1.0'),
          today(),
          JSON.stringify([{ menu_item_id: await menuItem(c, 'DAL-TADKA'), qty: 1 }]),
          'spreadsheet',
        ],
      );
      expect(r.error).toMatch(/INVALID_SOURCE/);
    });
  });
});

describe('cost control reads', () => {
  const variance = (c: PoolClient, who: string, store: string) =>
    attemptAs(c, ids.user(who), `select * from inv.variance($1, current_date - 7, current_date)`, [
      ids.node(store),
    ]);
  const costReport = (c: PoolClient, who: string, outlet: string) =>
    attemptAs(
      c,
      ids.user(who),
      `select * from menu.cost_report($1, current_date - 7, current_date)`,
      [ids.node(outlet)],
    );

  it('the variance report and cost % need cost access at the store', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [
        'test.cost-controller.1.0',
        'test.general-manager.1.0',
        'test.executive-chef.1.0',
      ]) {
        expect((await variance(c, who, 'TEST-HOTEL-1.0-KITCHEN-STORE')).error, who).toBeUndefined();
      }
      for (const who of ['test.store-keeper.1.0', 'test.chef-de-partie.1.0', 'test.commis.1.0']) {
        expect((await variance(c, who, 'TEST-HOTEL-1.0-KITCHEN-STORE')).error, who).toMatch(
          /NOT_AUTHORISED/,
        );
      }
      expect(
        (await variance(c, 'test.cost-controller.1.0', 'TEST-HOTEL-1.1-KITCHEN-STORE')).error,
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        (await costReport(c, 'test.cost-controller.1.0', 'TEST-HOTEL-1.0')).error,
      ).toBeUndefined();
      expect((await costReport(c, 'test.cost-controller.1.0', 'TEST-HOTEL-1.1')).error).toMatch(
        /NOT_AUTHORISED/,
      );
      expect((await costReport(c, 'test.bartender.1.0', 'TEST-HOTEL-1.0')).error).toMatch(
        /NOT_AUTHORISED/,
      );
    });
  });

  it('nobody writes production, sales or the ledger directly', async () => {
    await inRolledBackTx(async (c) => {
      for (const sql of [
        `insert into inv.production (tenant_id) values (core.my_tenant())`,
        `update inv.production set qty_made = 1`,
        `update menu.sales_line set qty = 1`,
        `delete from menu.sales_day`,
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty, ref_type)
           select tenant_id, item_id, delivery_node_id, 'sales_depletion', -1, 'x' from inv.stock_level limit 1`,
      ]) {
        const r = await attemptAs(c, ids.user('test.general-manager.1.0'), sql);
        expect(r.error, sql).toMatch(/permission denied/);
      }
    });
  });
});

describe('screen reads follow the same rules', () => {
  it('the production plan is for stock users where the item is made', async () => {
    await inRolledBackTx(async (c) => {
      const plan = (who: string, store: string, sku: string) =>
        item(c, sku).then((id) =>
          attemptAs<{ name: string; qty: string; unit: string }>(
            c,
            ids.user(who),
            'select * from inv.production_plan($1, $2)',
            [ids.node(store), id],
          ),
        );
      const ok = await plan(
        'test.chef-de-partie.1.0',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
        'GINGER-GARLIC-PASTE',
      );
      expect(ok.rows!.length).toBeGreaterThan(0);
      expect(Object.keys(ok.rows![0]!).some((k) => k.includes('cost'))).toBe(false);
      expect(
        (await plan('test.commis.1.0', 'TEST-HOTEL-1.0-KITCHEN-STORE', 'GINGER-GARLIC-PASTE'))
          .error,
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        (await plan('test.executive-chef.1.0', 'TEST-HOTEL-1.0-KITCHEN-STORE', 'MAKHANI-GRAVY'))
          .error,
      ).toMatch(/NOT_MADE_HERE/);
    });
  });

  it('the sales sheet is for those who post the outlet’s sales', async () => {
    await inRolledBackTx(async (c) => {
      const sheet = (who: string, outlet: string) =>
        attemptAs<{ code: string }>(
          c,
          ids.user(who),
          'select * from menu.sales_sheet($1, current_date)',
          [ids.node(outlet)],
        );
      expect((await sheet('test.cost-controller.1.0', 'TEST-HOTEL-1.0')).rows!.length).toBe(37);
      expect((await sheet('test.cost-controller.1.0', 'TEST-HOTEL-1.1')).error).toMatch(
        /NOT_AUTHORISED/,
      );
      expect((await sheet('test.bartender.1.0', 'TEST-HOTEL-1.0')).error).toMatch(/NOT_AUTHORISED/);
      const places = await attemptAs<{ outlet_id: string }>(
        c,
        ids.user('test.general-manager.1.0'),
        'select * from menu.my_sales_places()',
      );
      expect(places.rows!.map((p) => p.outlet_id)).toEqual([ids.node('TEST-HOTEL-1.0')]);
      const none = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        'select * from menu.my_sales_places()',
      );
      expect(none.rows).toEqual([]);
    });
  });
});
