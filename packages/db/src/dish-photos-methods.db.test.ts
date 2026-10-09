import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// A dish's photo and its method (GM items 2 and 8, ADR 078). A photo is set, changed or
// cleared only through menu.set_dish_photo, by whoever may change the dish's recipe (MENU
// modify at every store it is sold from); the key must be the company's and the dish's own.
// A dish's method sits beside the prep items' (inv.prep_procedure) and is read by whoever
// reads its recipe; inv.sub_recipes says which ingredients open their own recipe.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function dish(
  c: PoolClient,
  code: string,
  customer: 'TEST-COMPANY' | 'TEST-SOLO-COMPANY' = 'TEST-COMPANY',
): Promise<string> {
  const r = await c.query<{ id: string }>(
    'select id from menu.menu_item where code = $1 and tenant_id = $2',
    [code, ids.tenant(customer)],
  );
  return r.rows[0]!.id;
}

async function recipeOf(c: PoolClient, menuItem: string): Promise<string> {
  const r = await c.query<{ id: string }>(
    'select id from inv.recipe where menu_item_id = $1 and effective_to is null',
    [menuItem],
  );
  return r.rows[0]!.id;
}

const key = (tenant: string, id: string, ext = 'jpg') =>
  `items/${tenant}/${id}/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.${ext}`;

describe('dish photos (item 2)', () => {
  it('the bar manager of the only outlet selling it sets, changes and clears it, audited', async () => {
    await inRolledBackTx(async (c) => {
      const mojito = await dish(c, 'MOJITO', 'TEST-SOLO-COMPANY');
      const who = ids.user('test.solo.bar-manager');
      const k = key(ids.tenant('TEST-SOLO-COMPANY'), mojito);
      const can = await attemptAs<{ ok: boolean }>(c, who, 'select menu.can_edit_dish($1) as ok', [
        mojito,
      ]);
      expect(can.rows?.[0]?.ok).toBe(true);
      const r = await attemptAs(c, who, 'select menu.set_dish_photo($1, $2)', [mojito, k]);
      expect(r.error).toBeUndefined();
      // read back through the recipe's photos, as the app does
      const seen = await attemptAs<{ subject_id: string; photo_key: string }>(
        c,
        who,
        'select * from inv.recipe_photos()',
      );
      expect(seen.rows?.find((p) => p.subject_id === mojito)?.photo_key).toBe(k);
      const audit = await c.query(
        `select 1 from audit.log where table_name = 'menu.menu_item' and row_id = $1
            and op = 'UPDATE' and actor_id = $2`,
        [mojito, who],
      );
      expect(audit.rowCount).toBeGreaterThan(0);
      const cleared = await attemptAs(c, who, 'select menu.set_dish_photo($1, null)', [mojito]);
      expect(cleared.error).toBeUndefined();
      const after = await c.query<{ photo_key: string | null }>(
        'select photo_key from menu.menu_item where id = $1',
        [mojito],
      );
      expect(after.rows[0]!.photo_key).toBeNull();
    });
  });

  it('a dish sold at another outlet is beyond one GM; chefs, cost controllers and the AI may not', async () => {
    await inRolledBackTx(async (c) => {
      const butter = await dish(c, 'BUTTER-CHICKEN');
      const k = key(ids.tenant(), butter);
      for (const who of [
        'test.general-manager.1.0',
        'test.executive-chef.1.0',
        'test.cost-controller.1.0',
        'test.commis.1.0',
        'ai-agent',
      ]) {
        const r = await attemptAs(c, ids.user(who), 'select menu.set_dish_photo($1, $2)', [
          butter,
          k,
        ]);
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it("another company's dish, or a key that is not this dish's, is refused", async () => {
    await inRolledBackTx(async (c) => {
      const mojito = await dish(c, 'MOJITO', 'TEST-SOLO-COMPANY');
      const butter = await dish(c, 'BUTTER-CHICKEN');
      const who = ids.user('test.solo.bar-manager');
      const theirs = await attemptAs(c, who, 'select menu.set_dish_photo($1, $2)', [
        butter,
        key(ids.tenant('TEST-SOLO-COMPANY'), butter),
      ]);
      expect(theirs.error).toMatch(/NOT_AUTHORISED/);
      for (const bad of [
        key(ids.tenant(), mojito), // another company's prefix
        key(ids.tenant('TEST-SOLO-COMPANY'), butter), // another dish
        key(ids.tenant('TEST-SOLO-COMPANY'), mojito, 'gif'),
        `bills/${ids.tenant('TEST-SOLO-COMPANY')}/${mojito}/x.jpg`,
      ]) {
        const r = await attemptAs(c, who, 'select menu.set_dish_photo($1, $2)', [mojito, bad]);
        expect(r.error, bad).toMatch(/INVALID_PHOTO/);
      }
    });
  });

  it('nobody writes the photo straight into the table', async () => {
    await inRolledBackTx(async (c) => {
      const mojito = await dish(c, 'MOJITO', 'TEST-SOLO-COMPANY');
      const r = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        'update menu.menu_item set photo_key = $2 where id = $1',
        [mojito, key(ids.tenant('TEST-SOLO-COMPANY'), mojito)],
      );
      expect(r.error).toMatch(/permission denied/);
    });
  });
});

describe("a dish's method and its sub-recipes (item 8)", () => {
  async function addMethod(c: PoolClient, menuItem: string, tenant: string) {
    await c.query(
      `insert into inv.prep_procedure (tenant_id, menu_item_id, step, instruction, minutes)
       values ($1, $2, 1, 'Warm the gravy; add the chicken.', 5),
              ($1, $2, 2, 'Finish with cream and butter; garnish.', 2)`,
      [tenant, menuItem],
    );
  }

  it('whoever reads the recipe reads its method, in order; others do not', async () => {
    await inRolledBackTx(async (c) => {
      const dal = await dish(c, 'DAL-TADKA');
      await addMethod(c, dal, ids.tenant());
      const recipe = await recipeOf(c, dal);
      const commis = await attemptAs<{ step: number; instruction: string }>(
        c,
        ids.user('test.commis.1.0'),
        'select step, instruction from inv.recipe_method($1)',
        [recipe],
      );
      expect(commis.rows?.map((s) => s.step)).toEqual([1, 2]);
      // under RLS the commis sees the same rows straight from the table
      const direct = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        'select step from inv.prep_procedure where menu_item_id = $1',
        [dal],
      );
      expect(direct.rows?.length).toBe(2);
      for (const who of ['test.solo.bar-manager', 'test.housekeeping-supervisor.1.0']) {
        const r = await attemptAs(c, ids.user(who), 'select * from inv.recipe_method($1)', [
          recipe,
        ]);
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
        const rows = await attemptAs(
          c,
          ids.user(who),
          'select step from inv.prep_procedure where menu_item_id = $1',
          [dal],
        );
        expect(rows.rows?.length ?? 0, who).toBe(0);
      }
    });
  });

  it('a step belongs to a prep item or a dish, never both, and a dish lists a step once', async () => {
    await inRolledBackTx(async (c) => {
      const dal = await dish(c, 'DAL-TADKA');
      const gravy = await c.query<{ id: string }>(
        `select id from inv.item where sku = 'MAKHANI-GRAVY' and tenant_id = $1`,
        [ids.tenant()],
      );
      await c.query('savepoint mixed');
      await expect(
        c.query(
          `insert into inv.prep_procedure (tenant_id, prep_item_id, menu_item_id, step, instruction)
           values ($1, $2, $3, 9, 'x')`,
          [ids.tenant(), gravy.rows[0]!.id, dal],
        ),
      ).rejects.toThrow(/prep_procedure_subject/);
      await c.query('rollback to savepoint mixed');
      await addMethod(c, dal, ids.tenant());
      await c.query('savepoint twice');
      await expect(addMethod(c, dal, ids.tenant())).rejects.toThrow(/prep_procedure_menu_step/);
      await c.query('rollback to savepoint twice');
    });
  });

  it('an ingredient that is a prep item opens its recipe, for whoever may read it', async () => {
    await inRolledBackTx(async (c) => {
      const butter = await dish(c, 'BUTTER-CHICKEN');
      const recipe = await recipeOf(c, butter);
      const gravy = await c.query<{ id: string }>(
        `select r.id from inv.recipe r join inv.item i on i.id = r.prep_item_id
          where i.sku = 'MAKHANI-GRAVY' and i.tenant_id = $1 and r.effective_to is null`,
        [ids.tenant()],
      );
      const subs = await attemptAs<{ line_no: number; recipe_id: string }>(
        c,
        ids.user('test.general-manager.1.0'),
        'select * from inv.sub_recipes($1)',
        [recipe],
      );
      expect(subs.rows?.map((s) => s.recipe_id)).toEqual([gravy.rows[0]!.id]);
      const other = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        'select * from inv.sub_recipes($1)',
        [recipe],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});
