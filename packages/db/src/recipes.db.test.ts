import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Recipe rules and costing (ADR 014): versions with effective dates, no cycles, the
// ingredient's own recipe unit; cost at the store's weighted average while it has stock,
// standard cost otherwise, and prep costed through its sub-recipes where it is made.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const SOLO = 'TEST-SOLO-COMPANY';
const OWNER = 'test.solo.bar-manager';
// tomorrow in India, as the test connections' current_date (ADR 037)
const tomorrow = () =>
  new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

async function item(c: PoolClient, sku: string, customer = SOLO): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id where t.code = $1 and i.sku = $2`,
    [customer, sku],
  );
  return rows[0]!.id;
}
async function menuItem(c: PoolClient, code: string, customer = SOLO): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select m.id from menu.menu_item m join core.tenant t on t.id = m.tenant_id where t.code = $1 and m.code = $2`,
    [customer, code],
  );
  return rows[0]!.id;
}
async function lines(c: PoolClient, prep: string | null, menu: string | null) {
  const { rows } = await c.query<{
    ingredient_item_id: string;
    qty: string;
    unit: string;
    trim_loss_pct: string;
  }>(
    `select l.ingredient_item_id, l.qty, l.unit, l.trim_loss_pct
       from inv.recipe r join inv.recipe_line l on l.recipe_id = r.id
      where (r.prep_item_id = $1 or r.menu_item_id = $2) and r.effective_to is null order by l.line_no`,
    [prep, menu],
  );
  return rows.map((l) => ({ ...l, qty: Number(l.qty), trim_loss_pct: Number(l.trim_loss_pct) }));
}
const save = (
  c: PoolClient,
  kind: 'prep' | 'menu',
  subject: string,
  body: unknown[],
  from = tomorrow(),
) =>
  attemptAs<{ id: string }>(
    c,
    ids.user(OWNER),
    'select inv.save_recipe($1, $2, $3::jsonb, $4::date) as id',
    [kind, subject, JSON.stringify(body), from],
  );

describe('recipe rules', () => {
  it('rejects a prep item made from itself through a sub-recipe', async () => {
    await inRolledBackTx(async (c) => {
      const syrup = await item(c, 'SUGAR-SYRUP');
      const sour = await item(c, 'SOUR-MIX');
      const body = [
        ...(await lines(c, syrup, null)),
        { ingredient_item_id: sour, qty: 10, unit: 'ml' },
      ];
      const r = await save(c, 'prep', syrup, body);
      expect(r.error).toMatch(/RECIPE_CYCLE/);
      const self = await save(c, 'prep', syrup, [
        { ingredient_item_id: syrup, qty: 10, unit: 'ml' },
      ]);
      expect(self.error).toMatch(/RECIPE_CYCLE/);
    });
  });

  it('rejects a line in another unit, an empty recipe and a date in the past', async () => {
    await inRolledBackTx(async (c) => {
      const mojito = await menuItem(c, 'MOJITO');
      const body = await lines(c, null, mojito);
      const wrong = await save(c, 'menu', mojito, [
        { ...body[0]!, unit: body[0]!.unit === 'ml' ? 'g' : 'ml' },
      ]);
      expect(wrong.error).toMatch(/UNIT_MISMATCH/);
      expect((await save(c, 'menu', mojito, [])).error).toMatch(/INVALID_LINES/);
      expect((await save(c, 'menu', mojito, body, '2020-01-01')).error).toMatch(/INVALID_DATE/);
    });
  });

  it('an ingredient from another customer is refused', async () => {
    await inRolledBackTx(async (c) => {
      const mojito = await menuItem(c, 'MOJITO');
      const other = await item(c, 'SUGAR', 'TEST-COMPANY');
      const r = await save(c, 'menu', mojito, [{ ingredient_item_id: other, qty: 5, unit: 'g' }]);
      expect(r.error).toMatch(/TENANT_MISMATCH/);
    });
  });

  it('a change is a new version from its date; a second change that day replaces it', async () => {
    await inRolledBackTx(async (c) => {
      const mojito = await menuItem(c, 'MOJITO');
      const body = await lines(c, null, mojito);
      const first = await save(
        c,
        'menu',
        mojito,
        body.map((l, i) => (i === 0 ? { ...l, qty: l.qty + 1 } : l)),
      );
      const second = await save(
        c,
        'menu',
        mojito,
        body.map((l, i) => (i === 0 ? { ...l, qty: l.qty + 2 } : l)),
      );
      expect(first.error).toBeUndefined();
      expect(second.rows![0]!.id).toBe(first.rows![0]!.id);
      const { rows } = await c.query<{ version: number; from: string; to: string | null }>(
        `select version, effective_from::text as from, effective_to::text as to
           from inv.recipe where menu_item_id = $1 order by version`,
        [mojito],
      );
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ from: tomorrow(), to: null });
      // today still costs and sells the old version
      const { rows: today } = await c.query<{ version: number }>(
        `select (inv.recipe_on(null, $1, current_date)).version`,
        [mojito],
      );
      expect(today[0]!.version).toBe(1);
      expect((await lines(c, null, mojito))[0]!.qty).toBe(body[0]!.qty + 2);
    });
  });
});

describe('cost at current weighted average, standard where there is no stock', () => {
  const cost = async (c: PoolClient, sku: string, store: string, basis: string) =>
    Number(
      (
        await c.query<{ v: string }>(`select inv.unit_cost($1, $2, $3, current_date) as v`, [
          await item(c, sku, 'TEST-COMPANY'),
          ids.node(store),
          basis,
        ])
      ).rows[0]!.v,
    );

  it('a receipt at a new price moves the current cost per recipe unit, not the standard one', async () => {
    await inRolledBackTx(async (c) => {
      const store = 'TEST-HOTEL-1.0-KITCHEN-STORE';
      const before = await cost(c, 'BUTTER', store, 'current');
      const standard = await cost(c, 'BUTTER', store, 'standard');
      const { rows } = await c.query<{ on_hand: string; avg_cost: string }>(
        `select on_hand, avg_cost from inv.stock_level where item_id = $1 and delivery_node_id = $2`,
        [await item(c, 'BUTTER', 'TEST-COMPANY'), ids.node(store)],
      );
      const onHand = Number(rows[0]!.on_hand);
      // receive as much again at twice the average: the average moves halfway up
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty, unit_cost, ref_type)
         values ($1, $2, $3, 'receipt', $4, $5, 'test')`,
        [
          ids.tenant(),
          await item(c, 'BUTTER', 'TEST-COMPANY'),
          ids.node(store),
          onHand,
          Number(rows[0]!.avg_cost) * 2,
        ],
      );
      const after = await cost(c, 'BUTTER', store, 'current');
      expect(after).toBeCloseTo(before * 1.5, 6);
      expect(await cost(c, 'BUTTER', store, 'standard')).toBe(standard);
    });
  });

  it('a prep item with no stock is costed through its recipe where it is made', async () => {
    await inRolledBackTx(async (c) => {
      // Makhani Gravy is held at the hotel kitchen but made at the central kitchen
      const atHotel = await cost(c, 'MAKHANI-GRAVY', 'TEST-HOTEL-1.0-KITCHEN-STORE', 'current');
      const atCk = await cost(c, 'MAKHANI-GRAVY', 'TEST-CENTRAL-KITCHEN-STORE', 'current');
      expect(atHotel).toBe(atCk);
      expect(atHotel).toBeGreaterThan(0);
      // stock of it at the hotel (a transfer in) then sets its cost there
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty, unit_cost, ref_type)
         values ($1, $2, $3, 'transfer_in', 1000, 0.5, 'test')`,
        [
          ids.tenant(),
          await item(c, 'MAKHANI-GRAVY', 'TEST-COMPANY'),
          ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'),
        ],
      );
      expect(await cost(c, 'MAKHANI-GRAVY', 'TEST-HOTEL-1.0-KITCHEN-STORE', 'current')).toBe(0.5);
    });
  });
});
