import { join } from 'node:path';
import { closePools, inRolledBackTx, migratorPool } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCustomer } from './apply';
import { parseCsv } from './csv';
import { readCustomerDir } from './dir';

// Menu, recipes and prep (files 18-24, ADR 014). Costed at standard cost from what the loader
// stored, every batch, cost per unit, cost per serve and cost % equals the customer's
// generated 98 files to the paisa; and the files are checked across each other.

afterAll(closePools);

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');
const CUSTOMERS = [
  ['test-company', 'TEST-COMPANY'],
  ['test-solo-bar-co', 'TEST-SOLO-COMPANY'],
] as const;

const rows = (files: Record<string, string>, name: string) =>
  parseCsv(files[name]!).rows.map((r) => r.values);

describe.each(CUSTOMERS)('costing %s at standard cost', (dir, code) => {
  const files = readCustomerDir(join(DATA, dir));

  it('every prep batch and cost per unit equals 98_prep_costing_GENERATED.csv', async () => {
    const expected = rows(files, '98_prep_costing_GENERATED.csv');
    expect(expected.length).toBeGreaterThan(5);
    const { rows: got } = await migratorPool.query<{
      code: string;
      batch: string;
      per_unit: string;
    }>(
      `select i.sku as code,
              round(inv.recipe_cost(r.id, null, 'standard', current_date), 2)::text as batch,
              round(inv.unit_cost(i.id, null, 'standard', current_date), 4)::text as per_unit
         from inv.item i join core.tenant t on t.id = i.tenant_id
         join inv.recipe r on r.prep_item_id = i.id and r.effective_to is null
        where t.code = $1 and i.kind = 'prep'`,
      [code],
    );
    const byCode = new Map(got.map((g) => [g.code, g]));
    for (const e of expected) {
      const g = byCode.get(e.prep_item_code!);
      expect(g, e.prep_item_code).toBeDefined();
      expect(Number(g!.batch), `${e.prep_item_code} batch`).toBe(Number(e.batch_cost_inr));
      expect(Number(g!.per_unit), `${e.prep_item_code} per unit`).toBe(Number(e.cost_per_unit_inr));
    }
    expect(got.length).toBe(expected.length);
  });

  it('every menu item at every outlet equals 98_menu_costing_GENERATED.csv, through menu.outlet_costing', async () => {
    const expected = rows(files, '98_menu_costing_GENERATED.csv');
    expect(expected.length).toBeGreaterThan(20);
    // as someone who sees every outlet's costs: the area manager, or the solo owner
    const viewer = code === 'TEST-COMPANY' ? 'test.area-manager' : 'test.solo.bar-manager';
    const client = await migratorPool.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.user_id', (select u.id::text from core.app_user u
                                             join core.tenant t on t.id = u.tenant_id
                                            where t.code = $1 and u.username = $2), true)`,
        [code, viewer],
      );
      const outletIds = new Map<string, string>();
      for (const e of expected) outletIds.set(e.outlet_code!, await outletId(e.outlet_code!, code));
      await client.query(`set local role app_rw`);
      const outlets = [...new Set(expected.map((e) => e.outlet_code!))];
      const got = new Map<
        string,
        { store_code: string; price: string; cost_per_serve: string; cost_pct: string }
      >();
      for (const o of outlets) {
        const res = await client.query<{
          code: string;
          store_code: string;
          price: string;
          cost_per_serve: string;
          cost_pct: string;
        }>(
          `select code, store_code, price::text, cost_per_serve::text, cost_pct::text
              from menu.outlet_costing($1, 'standard')`,
          [outletIds.get(o)],
        );
        for (const x of res.rows) got.set(`${o} ${x.code}`, x);
      }
      for (const e of expected) {
        const g = got.get(`${e.outlet_code} ${e.menu_item_code}`);
        expect(g, `${e.outlet_code} ${e.menu_item_code}`).toBeDefined();
        expect(g!.store_code).toBe(e.sold_from_store_code);
        expect(Number(g!.price)).toBe(Number(e.price_inr_before_tax));
        expect(Number(g!.cost_per_serve), `${e.outlet_code} ${e.menu_item_code} cost`).toBe(
          Number(e.cost_per_serve_inr),
        );
        expect(`${Number(g!.cost_pct).toFixed(1)}%`, `${e.outlet_code} ${e.menu_item_code} %`).toBe(
          e.cost_pct,
        );
      }
      expect(got.size).toBe(expected.length);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

async function outletId(outlet: string, customer: string): Promise<string> {
  const { rows } = await migratorPool.query<{ id: string }>(
    `select n.id from core.hierarchy_node n join core.tenant t on t.id = n.tenant_id
      where t.code = $1 and n.code = $2`,
    [customer, outlet],
  );
  return rows[0]!.id;
}

describe('menu files are checked across each other', () => {
  const base = readCustomerDir(join(DATA, 'test-company'));
  const load = (c: PoolClient, edits: Record<string, (text: string) => string>) => {
    const files = { ...base };
    for (const [name, fn] of Object.entries(edits)) files[name] = fn(base[name]!);
    return loadCustomer(c, files, { nested: true, dryRun: true });
  };

  it('a recipe line in the wrong unit', async () => {
    await inRolledBackTx(async (c) => {
      const r = await load(c, {
        '21_recipes.csv': (t) =>
          t.replace(
            'MAKHANI-GRAVY,prep,BUTTER,raw,300,g,0',
            'MAKHANI-GRAVY,prep,BUTTER,raw,300,ml,0',
          ),
      });
      expect(r.issues).toEqual([
        { file: '21_recipes.csv', row: 3, column: 'unit', message: 'BUTTER is used in g, not ml' },
      ]);
    });
  });

  it('a prep item made at a store that does not stock its ingredient', async () => {
    await inRolledBackTx(async (c) => {
      const drop = (t: string) =>
        t
          .split(/\r?\n/)
          .filter((l) => !l.startsWith('GINGER,TEST-CENTRAL-KITCHEN-STORE,'))
          .join('\r\n');
      const r = await load(c, { '11_item_locations.csv': drop, '12_opening_stock.csv': drop });
      expect(r.issues.map((i) => i.message)).toContain(
        'MAKHANI-GRAVY is made at TEST-CENTRAL-KITCHEN-STORE, which does not stock its ingredient GINGER (11_item_locations.csv)',
      );
    });
  });

  it('a prep item made from itself through a sub-recipe', async () => {
    await inRolledBackTx(async (c) => {
      const r = await load(c, {
        '21_recipes.csv': (t) => `${t.trimEnd()}\r\nSUGAR-SYRUP,prep,SOUR-MIX,prep,10,ml,0\r\n`,
      });
      expect(r.issues.map((i) => i.message)).toEqual(
        expect.arrayContaining([
          'SUGAR-SYRUP is made from itself through its sub-recipes',
          'SOUR-MIX is made from itself through its sub-recipes',
        ]),
      );
    });
  });

  it('a menu item sold from another outlet’s store', async () => {
    await inRolledBackTx(async (c) => {
      const r = await load(c, {
        '23_menu_outlets.csv': (t) =>
          t.replace(
            'BUTTER-CHICKEN,TEST-HOTEL-1.0,TEST-HOTEL-1.0-KITCHEN-STORE,495',
            'BUTTER-CHICKEN,TEST-HOTEL-1.0,TEST-HOTEL-1.1-KITCHEN-STORE,495',
          ),
      });
      expect(r.issues).toEqual([
        {
          file: '23_menu_outlets.csv',
          row: 2,
          column: 'sold_from_store_code',
          message:
            "TEST-HOTEL-1.1-KITCHEN-STORE is not one of TEST-HOTEL-1.0's stores (03_node_links.csv)",
        },
      ]);
    });
  });

  it('warns, without blocking, when a menu item is sold from a store without one of its ingredients', async () => {
    await inRolledBackTx(async (c) => {
      const drop = (t: string) =>
        t
          .split(/\r?\n/)
          .filter((l) => !l.startsWith('SALT,TEST-HOTEL-1.0-BAR-STORE,'))
          .join('\r\n');
      const r = await load(c, { '11_item_locations.csv': drop, '12_opening_stock.csv': drop });
      expect(r.ok).toBe(true);
      expect(r.warnings.map((w) => w.message)).toEqual(
        expect.arrayContaining([
          'TEQUILA-SHOT-30ML is sold from TEST-HOTEL-1.0-BAR-STORE, which does not stock SALT: selling it will take SALT below zero there',
          'MARGARITA is sold from TEST-HOTEL-1.0-BAR-STORE, which does not stock SALT: selling it will take SALT below zero there',
        ]),
      );
    });
  });

  it('the shipped files raise no menu warnings', async () => {
    await inRolledBackTx(async (c) => {
      for (const [dir] of CUSTOMERS) {
        const r = await loadCustomer(c, readCustomerDir(join(DATA, dir)), {
          nested: true,
          dryRun: true,
        });
        expect(
          r.warnings.filter((w) => w.file === '23_menu_outlets.csv'),
          dir,
        ).toEqual([]);
      }
    });
  });

  it('a changed recipe line adds a version once, and loading again changes nothing', async () => {
    await inRolledBackTx(async (c) => {
      const changed = {
        '21_recipes.csv': (t: string) =>
          t.replace(
            'MAKHANI-GRAVY,prep,BUTTER,raw,300,g,0',
            'MAKHANI-GRAVY,prep,BUTTER,raw,320,g,0',
          ),
      };
      const files = {
        ...base,
        '21_recipes.csv': changed['21_recipes.csv'](base['21_recipes.csv']!),
      };
      const first = await loadCustomer(c, files, { nested: true });
      expect(first.counts['recipes']).toMatchObject({ updated: 1 });
      const again = await loadCustomer(c, files, { nested: true });
      expect(again.counts['recipes']).toMatchObject({ created: 0, updated: 0 });
      const { rows: lines } = await c.query<{ qty: string }>(
        `select l.qty from inv.recipe r join inv.item i on i.id = r.prep_item_id
           join inv.recipe_line l on l.recipe_id = r.id join inv.item b on b.id = l.ingredient_item_id
          join core.tenant t on t.id = i.tenant_id
         where t.code = 'TEST-COMPANY' and i.sku = 'MAKHANI-GRAVY' and b.sku = 'BUTTER'
           and r.effective_to is null`,
      );
      expect(lines.map((l) => Number(l.qty))).toEqual([320]);
    });
  });

  it('a price or recipe planned in the app for a later date stays planned when files are loaded', async () => {
    await inRolledBackTx(async (c) => {
      // start from no plan (an e2e run may have left one; this transaction is rolled back)
      await c.query(
        `delete from menu.menu_outlet mo using menu.menu_item m, core.hierarchy_node o
          where m.id = mo.menu_item_id and o.id = mo.org_node_id and m.code = 'BUTTER-CHICKEN'
            and o.code = 'TEST-HOTEL-1.0' and mo.effective_from > current_date`,
      );
      await c.query(
        `update menu.menu_outlet mo set effective_to = null
           from menu.menu_item m, core.hierarchy_node o
          where m.id = mo.menu_item_id and o.id = mo.org_node_id and m.code = 'BUTTER-CHICKEN'
            and o.code = 'TEST-HOTEL-1.0' and mo.effective_to >= current_date`,
      );
      const { rows } = await c.query<{ mo: string; item: string; outlet: string; store: string }>(
        `select mo.id as mo, mo.menu_item_id as item, mo.org_node_id as outlet,
                mo.delivery_node_id as store
           from menu.menu_outlet mo join menu.menu_item m on m.id = mo.menu_item_id
           join core.hierarchy_node o on o.id = mo.org_node_id
          where m.code = 'BUTTER-CHICKEN' and o.code = 'TEST-HOTEL-1.0' and mo.effective_to is null`,
      );
      const r = rows[0]!;
      // as menu.set_price does for a change from tomorrow
      await c.query(`update menu.menu_outlet set effective_to = current_date where id = $1`, [
        r.mo,
      ]);
      await c.query(
        `insert into menu.menu_outlet (tenant_id, menu_item_id, org_node_id, delivery_node_id, price,
                                       effective_from)
         select tenant_id, menu_item_id, org_node_id, delivery_node_id, 505, current_date + 1
           from menu.menu_outlet where id = $1`,
        [r.mo],
      );
      const same = await loadCustomer(c, base, { nested: true });
      expect(same.issues).toEqual([]);
      expect(same.counts['menu prices']).toMatchObject({ created: 0, updated: 0 });

      // a new price in the files applies from today until the planned change
      const files = {
        ...base,
        '23_menu_outlets.csv': base['23_menu_outlets.csv']!.replace(
          'BUTTER-CHICKEN,TEST-HOTEL-1.0,TEST-HOTEL-1.0-KITCHEN-STORE,495',
          'BUTTER-CHICKEN,TEST-HOTEL-1.0,TEST-HOTEL-1.0-KITCHEN-STORE,499',
        ),
      };
      const changed = await loadCustomer(c, files, { nested: true });
      expect(changed.issues).toEqual([]);
      const { rows: prices } = await c.query<{ price: string; open: boolean; planned: boolean }>(
        `select price::text, effective_to is null as open, effective_from > current_date as planned
           from menu.menu_outlet where menu_item_id = $1 and org_node_id = $2
            and (effective_to is null or effective_to >= current_date)
          order by effective_from`,
        [r.item, r.outlet],
      );
      expect(prices.map((p) => [Number(p.price), p.open, p.planned])).toEqual([
        [499, false, false],
        [505, true, true],
      ]);
    });
  });
});
