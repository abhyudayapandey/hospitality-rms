import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Allergens follow the recipe (ADR 138): a raw item is tagged once, and whatever is made from it
// carries its allergens, a prep item inside a dish too: on the recipe list (a prep item and a
// dish), a batch's label and a prep task. One list of 14 words for every customer (FSSAI's nine
// and the EU's five more); nothing else is stored. Hotel 1.0's kitchen, its sous chef and commis.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const STORE = 'TEST-HOTEL-1.0-KITCHEN-STORE';
const LEAD = 'test.sous-chef.1.0';
const COMMIS = 'test.commis.1.0';

async function ok<T extends object>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}

async function item(c: PoolClient, sku: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
      where t.code = 'TEST-COMPANY' and i.sku = $1`,
    [sku],
  );
  return rows[0]!.id;
}

const tag = (c: PoolClient, sku: string, allergens: string[]) =>
  c.query(
    `update inv.item i set allergens = $2 from core.tenant t
      where t.id = i.tenant_id and t.code = 'TEST-COMPANY' and i.sku = $1`,
    [sku, allergens],
  );

/** What the recipe list says a prep item or a dish carries, to its reader. */
async function listed(c: PoolClient, code: string): Promise<string[]> {
  const rows = await ok<{ code: string; allergens: string[] }>(
    c,
    LEAD,
    'select code, allergens from inv.my_recipes()',
  );
  const row = rows.find((r) => r.code === code);
  if (!row) throw new Error(`${code} is not on ${LEAD}'s recipe list`);
  return row.allergens;
}

describe('one allergen list', () => {
  it("is FSSAI's nine and the EU's five more; nothing else is stored", async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ w: string[] }>('select inv.allergen_words() as w');
      // the same words as ALLERGENS in packages/domain/src/food-label.ts
      expect(rows[0]!.w).toEqual([
        'gluten',
        'crustaceans',
        'milk',
        'egg',
        'fish',
        'peanuts',
        'tree nuts',
        'soy',
        'sulphites',
        'celery',
        'mustard',
        'sesame',
        'lupin',
        'molluscs',
      ]);
      await c.query('savepoint s');
      await expect(tag(c, 'GARLIC', ['nuts'])).rejects.toThrow(/item_allergens_known/);
      await c.query('rollback to savepoint s');
      await expect(
        c.query(
          `update menu.menu_item set allergens = '{shellfish}' where code = 'BUTTER-CHICKEN'`,
        ),
      ).rejects.toThrow(/menu_item_allergens_known/);
    });
  });
});

describe('allergens follow the recipe', () => {
  it('a prep item and a dish carry what is in them, all the way down, and their own tags', async () => {
    await inRolledBackTx(async (c) => {
      // the seed: butter and cream are milk; the makhani gravy says milk itself
      expect(await listed(c, 'GINGER-GARLIC-PASTE')).toEqual([]);
      expect(await listed(c, 'BUTTER-CHICKEN')).toEqual(['milk']);
      // garlic tagged once: the paste made with it carries it, and so does the makhani gravy
      // (garlic is in it) and the butter chicken (the gravy is in it)
      await tag(c, 'GARLIC', ['sesame']);
      expect(await listed(c, 'GINGER-GARLIC-PASTE')).toEqual(['sesame']);
      expect(await listed(c, 'MAKHANI-GRAVY')).toEqual(['milk', 'sesame']);
      expect(await listed(c, 'BUTTER-CHICKEN')).toEqual(['milk', 'sesame']);
      // a dish's own tag (a garnish no recipe line names) is added, never a removal
      await c.query(
        `update menu.menu_item m set allergens = '{celery}' from core.tenant t
          where t.id = m.tenant_id and t.code = 'TEST-COMPANY' and m.code = 'BUTTER-CHICKEN'`,
      );
      expect(await listed(c, 'BUTTER-CHICKEN')).toEqual(['celery', 'milk', 'sesame']);
      // untagged again, gone everywhere: nothing is copied
      await tag(c, 'GARLIC', []);
      expect(await listed(c, 'MAKHANI-GRAVY')).toEqual(['milk']);
      expect(await listed(c, 'BUTTER-CHICKEN')).toEqual(['celery', 'milk']);
    });
  });

  it("a batch's label and a prep task carry what the recipe's ingredients carry", async () => {
    await inRolledBackTx(async (c) => {
      const paste = await item(c, 'GINGER-GARLIC-PASTE');
      await tag(c, 'GARLIC', ['sesame']);
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                       unit_cost, ref_type)
         select n.tenant_id, l.ingredient_item_id, n.id, 'receipt', 10000, 1, 'fixture'
           from inv.recipe r join inv.recipe_line l on l.recipe_id = r.id
           join core.hierarchy_node n on n.id = $1
          where r.prep_item_id = $2 and r.effective_to is null`,
        [ids.node(STORE), paste],
      );
      const [made] = await ok<{ id: string }>(
        c,
        LEAD,
        'select inv.record_production($1, $2, 100) as id',
        [ids.node(STORE), paste],
      );
      const [label] = await ok<{ allergens: string[] }>(
        c,
        LEAD,
        'select allergens from inv.batch_label($1)',
        [made!.id],
      );
      expect(label!.allergens).toEqual(['sesame']);
      const batches = await ok<{ production_id: string; allergens: string[] }>(
        c,
        LEAD,
        'select production_id, allergens from inv.batches($1)',
        [ids.node(STORE)],
      );
      expect(batches.find((b) => b.production_id === made!.id)!.allergens).toEqual(['sesame']);

      const [t] = await ok<{ ids: string[] }>(
        c,
        LEAD,
        `select ops.create_prep_tasks($1, $2::jsonb, now() + interval '3 hours', $3::jsonb) as ids`,
        [
          ids.node(STORE),
          JSON.stringify([{ item_id: paste, qty: 200 }]),
          JSON.stringify({ mode: 'person', user_id: ids.user(COMMIS) }),
        ],
      );
      const [r] = await ok<{ r: { allergens: string[] } }>(
        c,
        COMMIS,
        'select ops.prep_task_recipe($1) as r',
        [t!.ids[0]],
      );
      expect(r!.r.allergens).toEqual(['sesame']);
    });
  });
});
