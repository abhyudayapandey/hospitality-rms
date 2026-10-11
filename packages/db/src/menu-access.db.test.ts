import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Menu, recipes and costs (Prompt 9a, ADR 014, 123). Who reads what, enforced by RLS:
//  - a recipe and its procedure: the managers of a department linked to a store that makes or
//    sells it (READS_RECIPES: executive and sous chefs, the bar manager, the restaurant and F&B
//    managers), the central kitchen's manager, and whoever has cost access (MENU: the outlet's
//    managers, cost controllers, area managers, the account owner). Nobody who only works or
//    leads a shift, and no store keeper; a cook given a prep task reads its recipe on the task.
//  - prices and costs: MENU view at the store (department heads through their linked store,
//    outlet managers, cost controllers, hub managers, area managers); never staff or store
//    keepers.
//  - editing: MENU modify (outlet managers) at every store the recipe or price is used at.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

/** Every recipe in a customer, by what it is for: prep item sku or menu item code. */
async function recipeCodes(c: PoolClient, customer = 'TEST-COMPANY'): Promise<Map<string, string>> {
  const { rows } = await c.query<{ id: string; code: string }>(
    `select r.id, coalesce(i.sku, m.code) as code
       from inv.recipe r join core.tenant t on t.id = r.tenant_id
       left join inv.item i on i.id = r.prep_item_id
       left join menu.menu_item m on m.id = r.menu_item_id
      where t.code = $1`,
    [customer],
  );
  return new Map(rows.map((r) => [r.id, r.code]));
}

/** The recipe codes `who` can read (current and past versions). */
async function readable(c: PoolClient, who: string): Promise<Set<string>> {
  const all = await recipeCodes(c);
  const solo = await recipeCodes(c, 'TEST-SOLO-COMPANY');
  const r = await attemptAs<{ id: string }>(c, ids.user(who), 'select id from inv.recipe');
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return new Set(r.rows.map((x) => all.get(x.id) ?? `SOLO:${solo.get(x.id) ?? x.id}`));
}

async function count(c: PoolClient, who: string, table: string): Promise<number> {
  const r = await attemptAs<{ n: number }>(
    c,
    ids.user(who),
    `select count(*)::int as n from ${table}`,
  );
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows[0]!.n;
}

const KITCHEN = [
  'BUTTER-CHICKEN',
  'DAL-TADKA',
  'GINGER-GARLIC-PASTE',
  'MINT-CHUTNEY',
  'STEAMED-RICE',
];
const BAR = [
  'MOJITO',
  'NEGRONI-SERVE',
  'SUGAR-SYRUP',
  'SOUR-MIX',
  'NEGRONI-BATCH',
  'HOUSE-SANGRIA-BATCH',
];
const BATCHED = ['NEGRONI-BATCH', 'OLD-FASHIONED-BATCH', 'HOUSE-SANGRIA-BATCH'];

describe('recipes are read only by the managers of where they are made or sold', () => {
  // ADR 123: whoever works or leads a shift reads no recipe, prices or costs; a cook given a
  // prep task reads that task's recipe through ops.prep_task_recipe (make-by-task.db.test.ts)
  it('frontline staff, shift leads and store keepers read no recipes', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [
        'test.room-attendant.1.0',
        'test.front-desk-executive.1.0',
        'test.security-guard.1.0',
        'test.room-attendant.2.0',
        'test.security-guard.2.0',
        'test.bartender.1.0',
        'test.head-bartender.1.0',
        'test.bar-back.1.0',
        'test.commis.1.0',
        'test.chef-de-partie.1.0',
        'test.kitchen-steward.1.0',
        'test.cook.2.0',
        'test.central-kitchen-commis',
        'test.store-keeper.1.0',
      ]) {
        for (const t of ['inv.recipe', 'inv.recipe_line', 'inv.prep_procedure', 'menu.menu_item']) {
          expect(await count(c, who, t), `${who} ${t}`).toBe(0);
        }
      }
    });
  });

  it('the bar manager reads bar recipes but not kitchen ones', async () => {
    await inRolledBackTx(async (c) => {
      const seen = await readable(c, 'test.bar-manager.1.0');
      for (const code of BAR) expect(seen, code).toContain(code);
      for (const code of KITCHEN) expect(seen, code).not.toContain(code);
      expect(seen).not.toContain('MAKHANI-GRAVY');
    });
  });

  it('a sous chef and the executive chef read kitchen recipes but not batched cocktails', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of ['test.sous-chef.1.0', 'test.executive-chef.1.0']) {
        const seen = await readable(c, who);
        for (const code of KITCHEN) expect(seen, `${who} ${code}`).toContain(code);
        for (const code of [...BATCHED, 'SUGAR-SYRUP', 'MOJITO'])
          expect(seen, `${who} ${code}`).not.toContain(code);
      }
    });
  });

  it('reads the lines and procedure steps of exactly the readable recipes', async () => {
    await inRolledBackTx(async (c) => {
      const n = await count(c, 'test.sous-chef.1.0', 'inv.prep_procedure');
      // and the methods of the dishes they read (ADR 078)
      const dishes = [...(await readable(c, 'test.sous-chef.1.0'))];
      const expected = await c.query<{ n: number }>(
        `select count(*)::int as n from inv.prep_procedure p
           left join inv.item i on i.id = p.prep_item_id
           left join menu.menu_item m on m.id = p.menu_item_id
           join core.tenant t on t.id = p.tenant_id
          where t.code = 'TEST-COMPANY'
            and (i.sku = any($1::text[]) or m.code = any($1::text[]))`,
        [dishes],
      );
      expect(expected.rows[0]!.n).toBeGreaterThan(10);
      expect(n).toBe(expected.rows[0]!.n);
      const lines = await count(c, 'test.bar-manager.1.0', 'inv.recipe_line');
      const visible = await readable(c, 'test.bar-manager.1.0');
      const all = await c.query<{ n: number }>(
        `select count(*)::int as n from inv.recipe_line l where l.recipe_id = any($1::uuid[])`,
        [
          [...(await recipeCodes(c)).entries()]
            .filter(([, code]) => visible.has(code))
            .map(([id]) => id),
        ],
      );
      expect(lines).toBe(all.rows[0]!.n);
    });
  });

  it('the central kitchen manager reads the gravies made there; its commis does not', async () => {
    await inRolledBackTx(async (c) => {
      const seen = await readable(c, 'test.central-kitchen-manager');
      expect(seen).toContain('MAKHANI-GRAVY');
      expect(seen).toContain('ONION-TOMATO-MASALA');
      for (const code of [
        'GINGER-GARLIC-PASTE',
        'STEAMED-RICE',
        'NEGRONI-BATCH',
        'BUTTER-CHICKEN',
      ]) {
        expect(seen, code).not.toContain(code);
      }
      expect((await readable(c, 'test.central-kitchen-commis')).size).toBe(0);
    });
  });

  it('the account owner reads every recipe and price in the company, and edits none', async () => {
    await inRolledBackTx(async (c) => {
      const seen = await readable(c, 'test.account-owner');
      for (const code of [...KITCHEN, ...BAR, ...BATCHED, 'MAKHANI-GRAVY']) {
        expect(seen, code).toContain(code);
      }
      expect([...seen].filter((s) => s.startsWith('SOLO:'))).toEqual([]);
      const places = await attemptAs<{ can_edit: boolean }>(
        c,
        ids.user('test.account-owner'),
        'select * from menu.my_menu_places()',
      );
      expect(places.rows!.length).toBeGreaterThan(2);
      expect(places.rows!.every((p) => !p.can_edit)).toBe(true);
    });
  });

  it('an outlet manager reads every recipe used in the outlet, received prep included', async () => {
    await inRolledBackTx(async (c) => {
      const seen = await readable(c, 'test.general-manager.1.0');
      for (const code of [...KITCHEN, ...BAR, ...BATCHED, 'MAKHANI-GRAVY', 'ONION-TOMATO-MASALA']) {
        expect(seen, code).toContain(code);
      }
    });
  });

  it('never reads another customer’s recipes', async () => {
    await inRolledBackTx(async (c) => {
      const seen = await readable(c, 'test.general-manager.1.0');
      expect([...seen].filter((s) => s.startsWith('SOLO:'))).toEqual([]);
      const solo = await readable(c, 'test.solo.bar-manager');
      expect(solo.size).toBeGreaterThan(0);
      expect([...solo].every((s) => s.startsWith('SOLO:'))).toBe(true);
    });
  });
});

describe('prices and costs', () => {
  async function costing(c: PoolClient, who: string, outlet: string) {
    return attemptAs<{ code: string; store: string; cost_per_serve: string }>(
      c,
      ids.user(who),
      `select code, store_code as store, cost_per_serve from menu.outlet_costing($1)`,
      [ids.node(outlet)],
    );
  }

  it('staff, supervisors and store keepers see no prices and no costs', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [
        'test.bartender.1.0',
        'test.commis.1.0',
        'test.head-bartender.1.0',
        'test.store-keeper.1.0',
        'test.room-attendant.1.0',
      ]) {
        expect(await count(c, who, 'menu.menu_outlet'), who).toBe(0);
        expect((await costing(c, who, 'TEST-HOTEL-1.0')).error, who).toMatch(/NOT_AUTHORISED/);
        const prep = await attemptAs(c, ids.user(who), 'select * from inv.prep_costing($1)', [
          ids.node('TEST-HOTEL-1.0-BAR-STORE'),
        ]);
        expect(prep.error, who).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('a department head sees the costs of their own department’s store only', async () => {
    await inRolledBackTx(async (c) => {
      const chef = await costing(c, 'test.executive-chef.1.0', 'TEST-HOTEL-1.0');
      expect(chef.error).toBeUndefined();
      const stores = new Set(chef.rows!.map((r) => r.store));
      expect(stores).toEqual(new Set(['TEST-HOTEL-1.0-KITCHEN-STORE']));
      const bar = await costing(c, 'test.bar-manager.1.0', 'TEST-HOTEL-1.0');
      expect(new Set(bar.rows!.map((r) => r.store))).toEqual(new Set(['TEST-HOTEL-1.0-BAR-STORE']));
      const prep = await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        'select * from inv.prep_costing($1)',
        [ids.node('TEST-HOTEL-1.0-BAR-STORE')],
      );
      expect(prep.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('a cost controller and the outlet manager see the whole outlet, not the next one', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of ['test.cost-controller.1.0', 'test.general-manager.1.0']) {
        const mine = await costing(c, who, 'TEST-HOTEL-1.0');
        expect(new Set(mine.rows!.map((r) => r.store)), who).toEqual(
          new Set(['TEST-HOTEL-1.0-KITCHEN-STORE', 'TEST-HOTEL-1.0-BAR-STORE']),
        );
        expect((await costing(c, who, 'TEST-HOTEL-1.1')).error, who).toMatch(/NOT_AUTHORISED/);
        // prices in force today (a later e2e may have planned one from tomorrow)
        expect(
          await count(
            c,
            who,
            `menu.menu_outlet where effective_from <= current_date
              and (effective_to is null or effective_to >= current_date)`,
          ),
          who,
        ).toBe(37);
      }
    });
  });

  it('the area manager sees costs across the area, read only', async () => {
    await inRolledBackTx(async (c) => {
      const r = await costing(c, 'test.area-manager', 'TEST-HOTEL-1.1');
      expect(r.error).toBeUndefined();
      expect(r.rows!.length).toBe(37);
    });
  });
});

describe('editing menus and recipes', () => {
  async function menuItem(c: PoolClient, code: string, customer = 'TEST-COMPANY') {
    const { rows } = await c.query<{ id: string }>(
      `select m.id from menu.menu_item m join core.tenant t on t.id = m.tenant_id
        where t.code = $1 and m.code = $2`,
      [customer, code],
    );
    return rows[0]!.id;
  }
  async function currentLines(c: PoolClient, menuItemId: string) {
    const { rows } = await c.query<{
      ingredient_item_id: string;
      qty: string;
      unit: string;
      trim_loss_pct: string;
    }>(
      `select l.ingredient_item_id, l.qty, l.unit, l.trim_loss_pct
         from inv.recipe r join inv.recipe_line l on l.recipe_id = r.id
        where r.menu_item_id = $1 and r.effective_to is null order by l.line_no`,
      [menuItemId],
    );
    return rows;
  }
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  it('an outlet manager sets a price at their outlet, not at another', async () => {
    await inRolledBackTx(async (c) => {
      const item = await menuItem(c, 'BUTTER-CHICKEN');
      const ok = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        'select menu.set_price($1, $2, $3, $4::date)',
        [item, ids.node('TEST-HOTEL-1.0'), 525, tomorrow()],
      );
      expect(ok.error).toBeUndefined();
      const other = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        'select menu.set_price($1, $2, $3, $4::date)',
        [item, ids.node('TEST-HOTEL-1.1'), 525, tomorrow()],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
      // the change is audited
      const { rows } = await c.query<{ n: number }>(
        `select count(*)::int as n from audit.log where table_name = 'menu.menu_outlet' and actor_id = $1`,
        [ids.user('test.general-manager.1.0')],
      );
      expect(rows[0]!.n).toBeGreaterThan(0);
    });
  });

  it('a recipe used at another outlet is beyond one outlet manager', async () => {
    await inRolledBackTx(async (c) => {
      const item = await menuItem(c, 'BUTTER-CHICKEN');
      const lines = await currentLines(c, item);
      const r = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        'select inv.save_recipe($1, $2, $3::jsonb, $4::date)',
        [
          'menu',
          item,
          JSON.stringify(lines.map((l) => ({ ...l, qty: Number(l.qty) + 1 }))),
          tomorrow(),
        ],
      );
      expect(r.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('an outlet manager changes a recipe used only in their outlet: a new audited version', async () => {
    await inRolledBackTx(async (c) => {
      const item = await menuItem(c, 'MOJITO', 'TEST-SOLO-COMPANY');
      const lines = await currentLines(c, item);
      const who = ids.user('test.solo.bar-manager');
      const r = await attemptAs<{ id: string }>(
        c,
        who,
        'select inv.save_recipe($1, $2, $3::jsonb, $4::date) as id',
        [
          'menu',
          item,
          JSON.stringify(lines.map((l, i) => (i === 0 ? { ...l, qty: Number(l.qty) + 5 } : l))),
          tomorrow(),
        ],
      );
      expect(r.error).toBeUndefined();
      const { rows } = await c.query<{ version: number; effective_to: string | null }>(
        `select version, effective_to::text from inv.recipe where menu_item_id = $1 order by version`,
        [item],
      );
      expect(rows.length).toBe(2);
      expect(rows[0]!.effective_to).not.toBeNull();
      expect(rows[1]!.effective_to).toBeNull();
      const audit = await c.query<{ n: number }>(
        `select count(*)::int as n from audit.log where table_name in ('inv.recipe', 'inv.recipe_line')
            and actor_id = $1`,
        [who],
      );
      expect(audit.rows[0]!.n).toBeGreaterThan(0);
    });
  });

  it('cost controllers, department heads, area managers and the AI agent cannot edit', async () => {
    await inRolledBackTx(async (c) => {
      const item = await menuItem(c, 'BUTTER-CHICKEN');
      const lines = JSON.stringify(await currentLines(c, item));
      for (const who of [
        'test.cost-controller.1.0',
        'test.executive-chef.1.0',
        'test.area-manager',
        'ai-agent',
      ]) {
        const r = await attemptAs(
          c,
          ids.user(who),
          'select inv.save_recipe($1, $2, $3::jsonb, $4::date)',
          ['menu', item, lines, tomorrow()],
        );
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
        const p = await attemptAs(c, ids.user(who), 'select menu.set_price($1, $2, $3, $4::date)', [
          item,
          ids.node('TEST-HOTEL-1.0'),
          1,
          tomorrow(),
        ]);
        expect(p.error, who).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('nobody writes the tables directly', async () => {
    await inRolledBackTx(async (c) => {
      const who = ids.user('test.general-manager.1.0');
      for (const sql of [
        `update inv.recipe set effective_to = current_date`,
        `delete from inv.recipe_line`,
        `update menu.menu_outlet set price = 1`,
        `insert into inv.prep_procedure (tenant_id, prep_item_id, step, instruction) select tenant_id, prep_item_id, 99, 'x' from inv.prep_procedure limit 1`,
      ]) {
        const r = await attemptAs(c, who, sql);
        expect(r.error, sql).toMatch(/permission denied/);
      }
    });
  });
});

describe('screen reads follow the same rules', () => {
  async function recipeOf(c: PoolClient, sku: string) {
    const { rows } = await c.query<{ id: string }>(
      `select r.id from inv.recipe r join inv.item i on i.id = r.prep_item_id
         join core.tenant t on t.id = r.tenant_id
        where t.code = 'TEST-COMPANY' and i.sku = $1 and r.effective_to is null`,
      [sku],
    );
    return rows[0]!.id;
  }

  it('my_recipes and the prep ids list the readable recipes, worked out once per call', async () => {
    // they compared each recipe with visible_recipe_ids() inline, re-running it per row
    // (9 s for a cost controller's Menu page); migration 20261019100000
    await inRolledBackTx(async (c) => {
      for (const u of [
        'test.cost-controller.1.0',
        'test.general-manager.1.0',
        'test.sous-chef.1.0',
      ]) {
        const who = ids.user(u);
        const started = Date.now();
        const list = await attemptAs<{ recipe_id: string }>(
          c,
          who,
          'select * from inv.my_recipes()',
        );
        const prep = await attemptAs<{ ids: string[] }>(
          c,
          who,
          'select inv.visible_prep_item_ids() as ids',
        );
        const took = Date.now() - started;
        const rls = await attemptAs<{ id: string; prep_item_id: string | null }>(
          c,
          who,
          `select id, prep_item_id from inv.recipe
            where effective_from <= current_date
              and (effective_to is null or effective_to >= current_date)`,
        );
        const all = await attemptAs<{ prep_item_id: string }>(
          c,
          who,
          'select distinct prep_item_id from inv.recipe where prep_item_id is not null',
        );
        expect(list.rows!.map((r) => r.recipe_id).sort(), u).toEqual(
          rls.rows!.map((r) => r.id).sort(),
        );
        expect([...prep.rows![0]!.ids].sort(), u).toEqual(
          all.rows!.map((r) => r.prep_item_id).sort(),
        );
        expect(took, `${u}: ${took} ms`).toBeLessThan(2000);
      }
    });
  });

  it('a sous chef lists and opens kitchen recipes; a commis lists none', async () => {
    await inRolledBackTx(async (c) => {
      const who = ids.user('test.sous-chef.1.0');
      const list = await attemptAs<{ code: string }>(c, who, 'select * from inv.my_recipes()');
      const codes = list.rows!.map((r) => r.code);
      expect(codes).toContain('GINGER-GARLIC-PASTE');
      expect(codes).not.toContain('NEGRONI-BATCH');
      const card = await attemptAs<{ name: string }>(c, who, 'select * from inv.recipe_card($1)', [
        await recipeOf(c, 'GINGER-GARLIC-PASTE'),
      ]);
      expect(card.rows!.length).toBeGreaterThan(0);
      const batch = await attemptAs(c, who, 'select * from inv.recipe_card($1)', [
        await recipeOf(c, 'NEGRONI-BATCH'),
      ]);
      expect(batch.error).toMatch(/NOT_AUTHORISED/);
      const commis = ids.user('test.commis.1.0');
      const none = await attemptAs<{ code: string }>(c, commis, 'select * from inv.my_recipes()');
      expect(none.rows ?? []).toEqual([]);
      const card2 = await attemptAs(c, commis, 'select * from inv.recipe_card($1)', [
        await recipeOf(c, 'GINGER-GARLIC-PASTE'),
      ]);
      expect(card2.error).toMatch(/NOT_AUTHORISED/);
      for (const fn of ['inv.recipe_ingredients()', 'menu.my_menu_places()']) {
        const r = await attemptAs<{ n: number }>(c, commis, `select count(*)::int as n from ${fn}`);
        expect(r.error ?? r.rows[0]!.n, fn).toSatisfy(
          (v: unknown) => v === 0 || /NOT_AUTHORISED/.test(String(v)),
        );
      }
    });
  });

  it('the executive chef sees line costs at the kitchen store only', async () => {
    await inRolledBackTx(async (c) => {
      const who = ids.user('test.executive-chef.1.0');
      const recipe = await recipeOf(c, 'GINGER-GARLIC-PASTE');
      const kitchen = await attemptAs<{ line_cost: string }>(
        c,
        who,
        'select * from inv.recipe_line_costs($1, $2)',
        [recipe, ids.node('TEST-HOTEL-1.0-KITCHEN-STORE')],
      );
      expect(kitchen.rows!.length).toBeGreaterThan(0);
      const bar = await attemptAs(c, who, 'select * from inv.recipe_line_costs($1, $2)', [
        recipe,
        ids.node('TEST-HOTEL-1.0-BAR-STORE'),
      ]);
      expect(bar.error).toMatch(/NOT_AUTHORISED/);
      const places = await attemptAs<{ store_name: string; can_edit: boolean }>(
        c,
        who,
        'select * from menu.my_menu_places()',
      );
      expect(places.rows!.map((p) => p.can_edit)).toEqual([false]);
    });
  });
});
