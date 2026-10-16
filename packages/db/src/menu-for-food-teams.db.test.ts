import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Everyone in a kitchen, bar or restaurant knows the menu and sees their store (ADR 165):
//  - READS_MENU (MENU_READER: RECIPES_TEAM at the whole outlet) reads every dish's and prep
//    item's recipe, ingredients and method made or sold at the outlet's department stores;
//  - never a price, cost or margin: menu.menu_outlet shows them no row and the costing
//    functions refuse them, in SQL, not only on the screen;
//  - SEES_DEPARTMENT_STOCK (SUPPLY_VIEWER at the department's store) shows its stock, read
//    only: no count, wastage, transfer or stock check, and no other department's store;
//  - housekeeping, the front office, security, engineering and the stores team gain nothing.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const COMMIS = 'test.commis.1.0';
const STEWARD = 'test.steward.1.0';
const BARTENDER = 'test.bartender.1.0';
const SERVER = 'test.server.3.0';
const SOLO_BARTENDER = 'test.solo.bartender';
const FOOD_TEAM = [COMMIS, STEWARD, BARTENDER, 'test.kitchen-steward.1.0', 'test.captain.1.0'];

const KITCHEN_STORE = 'TEST-HOTEL-1.0-KITCHEN-STORE';
const BAR_STORE = 'TEST-HOTEL-1.0-BAR-STORE';

/** Dishes and prep items of Hotel 1.0's kitchen and bar (menu-access.db.test.ts). */
const KITCHEN = ['BUTTER-CHICKEN', 'DAL-TADKA', 'GINGER-GARLIC-PASTE', 'STEAMED-RICE'];
const BAR = ['MOJITO', 'NEGRONI-SERVE', 'SUGAR-SYRUP', 'NEGRONI-BATCH'];

async function one<T extends object>(c: PoolClient, who: string, sql: string, p: unknown[] = []) {
  const r = await attemptAs<T>(c, ids.user(who), sql, p);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}

async function count(c: PoolClient, who: string, from: string, p: unknown[] = []) {
  return (await one<{ n: number }>(c, who, `select count(*)::int as n from ${from}`, p))[0]!.n;
}

/** The dish codes and prep skus `who` reads, in force today. */
async function readable(c: PoolClient, who: string): Promise<Set<string>> {
  const rows = await one<{ code: string }>(c, who, 'select code from inv.my_recipes()');
  return new Set(rows.map((r) => r.code));
}

async function recipeOf(c: PoolClient, code: string, customer = 'TEST-COMPANY'): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select r.id from inv.recipe r join core.tenant t on t.id = r.tenant_id
       left join inv.item i on i.id = r.prep_item_id
       left join menu.menu_item m on m.id = r.menu_item_id
      where t.code = $1 and coalesce(i.sku, m.code) = $2 and r.effective_to is null`,
    [customer, code],
  );
  return rows[0]!.id;
}

async function can(c: PoolClient, who: string, domain: string, access: string, store: string) {
  const r = await one<{ ok: boolean }>(c, who, `select core.can($1, $2, null, $3) as ok`, [
    domain,
    access,
    ids.node(store),
  ]);
  return r[0]!.ok;
}

describe('kitchen, bar and restaurant people read the menu', () => {
  it('a commis, a steward, a bartender and a server read every dish and its method', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [COMMIS, STEWARD, BARTENDER, 'test.kitchen-steward.1.0']) {
        const seen = await readable(c, who);
        for (const code of [...KITCHEN, ...BAR]) expect(seen, `${who} ${code}`).toContain(code);
        expect(await count(c, who, 'menu.menu_item'), who).toBeGreaterThan(5);
        // the ingredients and the method of a dish and of a prep item
        for (const code of ['BUTTER-CHICKEN', 'GINGER-GARLIC-PASTE', 'MOJITO']) {
          const recipe = await recipeOf(c, code);
          expect(await count(c, who, 'inv.recipe_card($1)', [recipe]), `${who} ${code}`).toBe(
            await c
              .query<{ n: number }>(
                'select count(*)::int as n from inv.recipe_line where recipe_id = $1',
                [recipe],
              )
              .then((r) => r.rows[0]!.n),
          );
          expect(await count(c, who, 'inv.recipe_method($1)', [recipe]), `${who} ${code}`).toBe(
            await c
              .query<{ n: number }>(
                `select count(*)::int as n from inv.prep_procedure p join inv.recipe r
                    on r.id = $1 and (p.prep_item_id = r.prep_item_id
                                      or p.menu_item_id = r.menu_item_id)`,
                [recipe],
              )
              .then((r) => r.rows[0]!.n),
          );
        }
      }
      // at least one of those methods has steps: the Recipe tab is not empty
      expect(
        await count(c, COMMIS, 'inv.recipe_method($1)', [await recipeOf(c, 'GINGER-GARLIC-PASTE')]),
      ).toBeGreaterThan(0);
      // the bar's floor staff at Bar 3.0, and Test Solo Bar Co.'s bartender, read theirs
      expect((await readable(c, SERVER)).size).toBeGreaterThan(5);
      expect((await readable(c, SOLO_BARTENDER)).size).toBeGreaterThan(3);
    });
  });

  it('reads only their own outlet and their own company', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select r.id from inv.recipe r join core.tenant t on t.id = r.tenant_id
          where t.code = 'TEST-SOLO-COMPANY'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      const mine = new Set(
        (await one<{ id: string }>(c, COMMIS, 'select id from inv.recipe')).map((r) => r.id),
      );
      expect(rows.filter((r) => mine.has(r.id))).toEqual([]);
      const solo = new Set(
        (await one<{ id: string }>(c, SOLO_BARTENDER, 'select id from inv.recipe')).map(
          (r) => r.id,
        ),
      );
      expect([...mine].filter((id) => solo.has(id))).toEqual([]);
      // the hotel's dishes Bar 3.0 does not sell are not on Bar 3.0's menu
      const bar3 = await readable(c, SERVER);
      expect(await readable(c, COMMIS)).toContain('SURMAI-FRY');
      expect(bar3).not.toContain('SURMAI-FRY');
      expect(bar3).not.toContain('DAL-TADKA');
    });
  });

  it('never sees a price, a cost or a margin, in SQL', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [...FOOD_TEAM, SERVER, SOLO_BARTENDER]) {
        // prices are rows of menu.menu_outlet: none
        expect(await count(c, who, 'menu.menu_outlet'), who).toBe(0);
        // no place where they see menu costs
        expect(await count(c, who, 'menu.my_menu_places()'), who).toBe(0);
        const outlet = who === SERVER ? 'TEST-BAR-3.0' : 'TEST-HOTEL-1.0';
        if (who !== SOLO_BARTENDER) {
          const costing = await attemptAs(
            c,
            ids.user(who),
            'select * from menu.outlet_costing($1)',
            [ids.node(outlet)],
          );
          expect(costing.error, who).toMatch(/NOT_AUTHORISED/);
          for (const store of [KITCHEN_STORE, BAR_STORE]) {
            const prep = await attemptAs(c, ids.user(who), 'select * from inv.prep_costing($1)', [
              ids.node(store),
            ]);
            expect(prep.error, `${who} ${store}`).toMatch(/NOT_AUTHORISED/);
            const lines = await attemptAs(
              c,
              ids.user(who),
              'select * from inv.recipe_line_costs($1, $2)',
              [await recipeOf(c, 'BUTTER-CHICKEN'), ids.node(store)],
            );
            expect(lines.error, `${who} ${store}`).toMatch(/NOT_AUTHORISED/);
            // what stock is worth at the store: null for them (ADR 145)
            const money = await one<{ sees: boolean }>(
              c,
              who,
              'select inv.sees_store_money($1) as sees',
              [ids.node(store)],
            );
            expect(money[0]!.sees, `${who} ${store}`).toBe(false);
            expect(await can(c, who, 'MENU', 'view', store), `${who} ${store}`).toBe(false);
          }
        }
        // the recipe card itself carries no money
        const card = await one<Record<string, unknown>>(
          c,
          who,
          'select * from inv.recipe_card($1) limit 1',
          [
            await recipeOf(
              c,
              who === SOLO_BARTENDER ? 'MOJITO' : 'BUTTER-CHICKEN',
              who === SOLO_BARTENDER ? 'TEST-SOLO-COMPANY' : 'TEST-COMPANY',
            ),
          ],
        );
        expect(card.length, who).toBe(1);
        expect(
          Object.keys(card[0]!).filter((k) => /price|cost|margin|value/.test(k)),
          who,
        ).toEqual([]);
      }
    });
  });

  it('changes no recipe and no price', async () => {
    await inRolledBackTx(async (c) => {
      const recipe = await recipeOf(c, 'BUTTER-CHICKEN');
      const { rows } = await c.query<{ menu_item_id: string }>(
        'select menu_item_id from inv.recipe where id = $1',
        [recipe],
      );
      const dish = rows[0]!.menu_item_id;
      const lines = JSON.stringify(
        (
          await c.query(
            `select ingredient_item_id, qty, unit, trim_loss_pct from inv.recipe_line
              where recipe_id = $1 order by line_no`,
            [recipe],
          )
        ).rows,
      );
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      for (const who of FOOD_TEAM) {
        const save = await attemptAs(
          c,
          ids.user(who),
          'select inv.save_recipe($1, $2, $3::jsonb, $4::date)',
          ['menu', dish, lines, tomorrow],
        );
        expect(save.error, who).toMatch(/NOT_AUTHORISED/);
        const price = await attemptAs(
          c,
          ids.user(who),
          'select menu.set_price($1, $2, $3, $4::date)',
          [dish, ids.node('TEST-HOTEL-1.0'), 1, tomorrow],
        );
        expect(price.error, who).toMatch(/NOT_AUTHORISED/);
        expect(
          (await one<{ ok: boolean }>(c, who, 'select menu.can_edit_dish($1) as ok', [dish]))[0]!
            .ok,
          who,
        ).toBe(false);
      }
    });
  });
});

describe('their own department’s stock, read only', () => {
  it('a commis and a kitchen steward see the kitchen store, not the bar’s', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [COMMIS, 'test.kitchen-steward.1.0']) {
        expect(await can(c, who, 'STOCK_LEVELS', 'view', KITCHEN_STORE), who).toBe(true);
        expect(await can(c, who, 'STOCK_LEVELS', 'view', BAR_STORE), who).toBe(false);
        expect(
          await count(c, who, 'inv.stock_level where delivery_node_id = $1', [
            ids.node(KITCHEN_STORE),
          ]),
          who,
        ).toBeGreaterThan(0);
        expect(
          await count(c, who, 'inv.stock_level where delivery_node_id <> $1', [
            ids.node(KITCHEN_STORE),
          ]),
          who,
        ).toBe(0);
      }
    });
  });

  it('a bartender sees the bar store, not the kitchen’s; a steward sees no store', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [BARTENDER, 'test.bar-back.1.0']) {
        expect(await can(c, who, 'STOCK_LEVELS', 'view', BAR_STORE), who).toBe(true);
        expect(await can(c, who, 'STOCK_LEVELS', 'view', KITCHEN_STORE), who).toBe(false);
        expect(
          await count(c, who, 'inv.stock_level where delivery_node_id <> $1', [
            ids.node(BAR_STORE),
          ]),
          who,
        ).toBe(0);
      }
      // the restaurant keeps no store of its own: its people read the menu, no stock
      for (const who of [STEWARD, 'test.captain.1.0']) {
        expect(await count(c, who, 'inv.stock_level'), who).toBe(0);
      }
      expect(
        await count(c, SOLO_BARTENDER, 'inv.stock_level where delivery_node_id = $1', [
          ids.node('TEST-SOLO-BAR-BAR-STORE'),
        ]),
      ).toBeGreaterThan(0);
    });
  });

  it('cannot count, record wastage, move stock or verify a stock check', async () => {
    await inRolledBackTx(async (c) => {
      for (const [who, store] of [
        [COMMIS, KITCHEN_STORE],
        ['test.kitchen-steward.1.0', KITCHEN_STORE],
        [BARTENDER, BAR_STORE],
        ['test.bar-back.1.0', BAR_STORE],
      ] as const) {
        for (const [domain, access] of [
          ['STOCK_ADJUSTMENTS', 'modify'],
          ['TRANSFERS', 'modify'],
          ['STOCK_CHECK', 'view'],
          ['STOCK_CHECK', 'modify'],
          ['PURCHASE_ORDERS', 'view'],
          ['BILLS', 'view'],
        ] as const) {
          // so a figure below zero reads "Count needed" for them (ADR 101)
          expect(await can(c, who, domain, access, store), `${who} ${domain} ${access}`).toBe(
            false,
          );
        }
        const { rows } = await c.query<{ id: string }>(
          `select item_id as id from inv.item_node where delivery_node_id = $1
            and archived_at is null limit 1`,
          [ids.node(store)],
        );
        const wastage = await attemptAs(
          c,
          ids.user(who),
          'select inv.record_wastage($1, $2::jsonb)',
          [ids.node(store), JSON.stringify([{ item_id: rows[0]!.id, qty: 1, reason: 'spoiled' }])],
        );
        expect(wastage.error, who).toMatch(/NOT_AUTHORISED/);
        const count = await attemptAs(c, ids.user(who), 'select inv.start_count($1)', [
          ids.node(store),
        ]);
        expect(count.error, who).toMatch(/NOT_AUTHORISED/);
        const ledger = await attemptAs(
          c,
          ids.user(who),
          `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                         unit_cost, occurred_at)
           select tenant_id, item_id, delivery_node_id, 'adjustment', 1, 0, now()
             from inv.stock_level where delivery_node_id = $1 limit 1`,
          [ids.node(store)],
        );
        expect(ledger.error, who).toMatch(/permission denied/);
      }
    });
  });
});

describe('housekeeping, the front office and the back office gain nothing', () => {
  it('read no recipe, no dish and no store', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [
        'test.room-attendant.1.0',
        'test.front-desk-executive.1.0',
        'test.bellboy.1.0',
        'test.security-guard.1.0',
        'test.technician.1.0',
        'test.room-attendant.2.0',
      ]) {
        for (const t of ['inv.recipe', 'inv.recipe_line', 'inv.prep_procedure', 'menu.menu_item']) {
          expect(await count(c, who, t), `${who} ${t}`).toBe(0);
        }
        expect(await count(c, who, 'menu.menu_outlet'), who).toBe(0);
        expect(await count(c, who, 'inv.stock_level'), who).toBe(0);
        const groups = await one<{ access_group: string }>(
          c,
          who,
          'select access_group from core.my_access()',
        );
        expect(
          groups
            .map((g) => g.access_group)
            .filter((g) => g === 'MENU_READER' || g === 'SUPPLY_VIEWER'),
          who,
        ).toEqual([]);
      }
    });
  });
});
