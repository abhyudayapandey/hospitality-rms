import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The cost controller's reports (R-2, ADR 028) on the test data: the figures
// docs/onboarding/test-data/README.md promises, one definition per figure (the report
// adds up the same functions the old screens used), the stores each person sees, and the
// test-only purchase functions behind file 33. Who may open which report, for every user,
// is in reports-access.db.test.ts.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

/** The 7 days ending on the day of the Hotel 1.0 Bar Store closing count (the load day). */
async function window(c: PoolClient): Promise<{ from: string; to: string; from28: string }> {
  const { rows } = await c.query<{ from: string; to: string; from28: string }>(
    `select (d - 6)::text as from, d::text as to, (d - 27)::text as from28
       from (select (max(submitted_at) at time zone 'Asia/Kolkata')::date as d
               from inv.stock_count where delivery_node_id = $1 and status = 'submitted') x`,
    [ids.node('TEST-HOTEL-1.0-BAR-STORE')],
  );
  return rows[0]!;
}

async function as<T extends object>(c: PoolClient, user: string, sql: string, params: unknown[]) {
  const r = await attemptAs<T>(c, ids.user(user), sql, params);
  if (r.error !== undefined) throw new Error(`${sql}: ${r.error}`);
  return r.rows;
}

async function measures(c: PoolClient, user: string, sql: string, params: unknown[]) {
  const rows = await as<{ measure: string; value: string | null }>(c, user, sql, params);
  return Object.fromEntries(rows.map((r) => [r.measure, n(r.value)]));
}

describe('cost of sales (replaces Variance)', () => {
  it('Hotel 1.0: the README figures, item by item and in total', async () => {
    await inRolledBackTx(async (c) => {
      const w = await window(c);
      const t = await measures(
        c,
        'test.cost-controller.1.0',
        'select * from rpt.cost_totals($1, $2, $3)',
        [ids.node('TEST-HOTEL-1.0'), w.from, w.to],
      );
      expect(t).toMatchObject({
        bar_sales: 107550,
        bar_cost_pct: 36.2,
        bar_recipe_pct: 34.4,
        food_sales: 37620,
        food_cost_pct: 21.5,
        food_recipe_pct: 21.5,
        count_loss: 1940, // gin 1,800 + vodka 140
        beyond_tolerance: 1, // the gin
      });
      const items = await as<{ sku: string; store_name: string; variance_value: string }>(
        c,
        'test.cost-controller.1.0',
        'select sku, store_name, variance_value from rpt.cost_items($1, $2, $3)',
        [ids.node('TEST-HOTEL-1.0'), w.from, w.to],
      );
      // the biggest loss first
      expect(items.slice(0, 2).map((i) => [i.sku, n(i.variance_value)])).toEqual([
        ['GIN-750ML', -1800],
        ['VODKA-750ML', -140],
      ]);
      expect(items[0]!.store_name).toBe('Test Hotel & Bar 1.0 – Bar Store');
    });
  });

  it('adds up inv.variance store by store: the old Variance screen and the report agree', async () => {
    await inRolledBackTx(async (c) => {
      const w = await window(c);
      const user = 'test.cost-controller.1.0';
      const stores = await as<{ id: string }>(
        c,
        user,
        `select distinct store_id as id from rpt.cost_items($1, $2, $3)`,
        [ids.node('TEST-HOTEL-1.0'), w.from, w.to],
      );
      expect(stores.length).toBeGreaterThan(1);
      let fromVariance = 0;
      for (const s of stores) {
        const v = await as<{ value: string }>(
          c,
          user,
          `select coalesce(sum(variance_value), 0) as value from inv.variance($1, $2, $3)`,
          [s.id, w.from, w.to],
        );
        fromVariance += Number(v[0]!.value);
      }
      const report = await as<{ value: string }>(
        c,
        user,
        `select coalesce(sum(variance_value), 0) as value from rpt.cost_items($1, $2, $3)`,
        [ids.node('TEST-HOTEL-1.0'), w.from, w.to],
      );
      expect(Number(report[0]!.value)).toBe(fromVariance);
      // and menu.cost_report gives the same cost % as the report's tiles
      const old = await as<{ menu: string; actual_pct: string }>(
        c,
        user,
        `select menu, actual_pct from menu.cost_report($1, $2, $3) order by menu`,
        [ids.node('TEST-HOTEL-1.0'), w.from, w.to],
      );
      expect(old.map((o) => [o.menu, n(o.actual_pct)])).toEqual([
        ['Bar', 36.2],
        ['Food', 21.5],
      ]);
    });
  });

  it('each person sees their own stores: the chef the kitchen, the owner everything', async () => {
    await inRolledBackTx(async (c) => {
      const w = await window(c);
      const storesOf = async (user: string) =>
        (
          await as<{ store_name: string }>(
            c,
            user,
            'select distinct store_name from rpt.cost_items($1, $2, $3) order by 1',
            [ids.node('TEST-HOTEL-1.0'), w.from, w.to],
          )
        ).map((r) => r.store_name);
      expect(await storesOf('test.executive-chef.1.0')).toEqual([
        'Test Hotel & Bar 1.0 – Kitchen Store',
      ]);
      const owner = await storesOf('test.account-owner');
      expect(owner).toEqual(await storesOf('test.general-manager.1.0'));
      expect(owner).toContain('Test Hotel & Bar 1.0 – Bar Store');
      // the owner's totals are the GM's (REPORTS reads everything, changes nothing)
      const sql = 'select * from rpt.cost_totals($1, $2, $3)';
      const p = [ids.node('TEST-HOTEL-1.0'), w.from, w.to];
      expect(await measures(c, 'test.account-owner', sql, p)).toEqual(
        await measures(c, 'test.general-manager.1.0', sql, p),
      );
    });
  });

  it('the central kitchen is a place of its own: its hub store, not the outlets it supplies', async () => {
    await inRolledBackTx(async (c) => {
      const w = await window(c);
      const stores = await as<{ store_name: string }>(
        c,
        'test.account-owner',
        'select distinct store_name from rpt.cost_items($1, $2, $3)',
        [ids.node('TEST-CENTRAL-KITCHEN'), w.from, w.to],
      );
      expect(stores.map((s) => s.store_name)).toEqual(['Test Central Kitchen – Store']);
    });
  });

  it('a day runs 06:00 to 06:00, like the other reports: 02:00 belongs to the night before', async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node('TEST-HOTEL-1.0-BAR-STORE');
      const { rows: item } = await c.query<{ id: string }>(
        `select id from inv.item where tenant_id = $1 and sku = 'GIN-750ML'`,
        [ids.tenant()],
      );
      for (const [time, qty] of [
        ['02:00', -1],
        ['07:00', -0.5],
      ] as const) {
        await c.query(
          `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                         unit_cost, ref_type, occurred_at)
           values ($1, $2, $3, 'wastage', $4, 100, 'test', ('2026-09-10'::date + $5::time) at time zone 'Asia/Kolkata')`,
          [ids.tenant(), item[0]!.id, store, qty, time],
        );
      }
      const wastage = async (day: string) =>
        (
          await measures(
            c,
            'test.cost-controller.1.0',
            'select * from rpt.cost_totals($1, $2, $3)',
            [ids.node('TEST-HOTEL-1.0'), day, day],
          )
        ).wastage;
      expect(await wastage('2026-09-09')).toBe(100);
      expect(await wastage('2026-09-10')).toBe(50);
    });
  });
});

describe('menu engineering', () => {
  interface Dish {
    menu: string;
    code: string;
    sold: string;
    margin: string;
    mix_pct: string;
    avg_margin: string;
    popular_from_pct: string;
    class: string | null;
  }
  const dishes = async (c: PoolClient) => {
    const w = await window(c);
    const rows = await as<Dish>(
      c,
      'test.cost-controller.1.0',
      'select * from rpt.menu_engineering($1, $2, $3)',
      [ids.node('TEST-HOTEL-1.0'), w.from, w.to],
    );
    return new Map(rows.map((r) => [r.code, r]));
  };

  it('Hotel 1.0: each dish in its quadrant (README)', async () => {
    await inRolledBackTx(async (c) => {
      const d = await dishes(c);
      const cls = (code: string) => d.get(code)!.class;
      // Bar: 27 drinks on the menu, so popular from 0.7 / 27 = 2.6% of drinks sold
      expect(n(d.get('GIN-AND-TONIC')!.popular_from_pct)).toBe(2.6);
      expect(n(d.get('GIN-AND-TONIC')!.avg_margin)).toBe(244.97);
      expect(cls('GIN-AND-TONIC')).toBe('star');
      expect(cls('WHISKY-SOUR')).toBe('star');
      expect(cls('MOJITO')).toBe('star');
      expect(cls('LAGER-330ML-SERVE')).toBe('plowhorse');
      expect(cls('VODKA-PEG-30ML')).toBe('plowhorse');
      expect(cls('RED-WINE-GLASS')).toBe('plowhorse');
      // not sold this week: a dog below the average margin, a puzzle above it
      expect(cls('WHISKY-PEG-30ML')).toBe('dog');
      expect(cls('COSMOPOLITAN')).toBe('puzzle');
      // Food: 10 dishes, popular from 7%
      expect(n(d.get('BUTTER-NAAN')!.popular_from_pct)).toBe(7);
      expect(cls('MASALA-FRIES')).toBe('star');
      expect(cls('SURMAI-FRY')).toBe('star');
      expect(cls('BUTTER-NAAN')).toBe('plowhorse');
      expect(cls('PANEER-TIKKA')).toBe('puzzle');
      // mix adds up to 100% per menu
      for (const menu of ['Bar', 'Food']) {
        const total = [...d.values()]
          .filter((x) => x.menu === menu)
          .reduce((s, x) => s + Number(x.mix_pct), 0);
        expect(Math.round(total)).toBe(100);
      }
    });
  });

  it('the popularity threshold is a company setting (R-4): at 100%, an equal share', async () => {
    await inRolledBackTx(async (c) => {
      await as(
        c,
        'test.account-owner',
        `select core.set_company_settings('{"menu_popular_pct": 100}')`,
        [],
      );
      const d = await dishes(c);
      // 1 / 27 drinks = 3.7%; 1 / 10 dishes = 10%
      expect(n(d.get('GIN-AND-TONIC')!.popular_from_pct)).toBe(3.7);
      expect(n(d.get('BUTTER-NAAN')!.popular_from_pct)).toBe(10);
    });
  });

  it('the average margin is weighted by what sold', async () => {
    await inRolledBackTx(async (c) => {
      const d = [...(await dishes(c)).values()].filter((x) => x.menu === 'Food');
      const sold = d.reduce((s, x) => s + Number(x.sold), 0);
      const weighted = d.reduce((s, x) => s + Number(x.sold) * Number(x.margin), 0) / sold;
      expect(Number(d[0]!.avg_margin)).toBeCloseTo(weighted, 1);
    });
  });

  it('runs over up to a year (RPT-13: 3, 6, 9 and 12 months); never longer', async () => {
    await inRolledBackTx(async (c) => {
      const w = await window(c);
      const week = await dishes(c);
      // the test data's sales are all in the last week: a year gives the same figures
      const year = await as<Dish>(
        c,
        'test.cost-controller.1.0',
        `select * from rpt.menu_engineering($1, $2::date - 365, $2::date)`,
        [ids.node('TEST-HOTEL-1.0'), w.to],
      );
      expect(year.length).toBe(week.size);
      for (const r of year) {
        expect([r.code, r.sold, r.class]).toEqual([
          r.code,
          week.get(r.code)!.sold,
          week.get(r.code)!.class,
        ]);
      }
      const tooLong = await attemptAs(
        c,
        ids.user('test.cost-controller.1.0'),
        `select * from rpt.menu_engineering($1, $2::date - 366, $2::date)`,
        [ids.node('TEST-HOTEL-1.0'), w.to],
      );
      expect(tooLong.error).toBe('INVALID_DATES');
    });
  });
});

describe('stock position', () => {
  const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN-STORE';

  it('Hotel 1.0 Kitchen Store: value, days on hand over the 7 days in use, dead stock', async () => {
    await inRolledBackTx(async (c) => {
      const chef = 'test.executive-chef.1.0';
      const s = await measures(c, chef, 'select * from rpt.stock_summary($1)', [ids.node(KITCHEN)]);
      const items = await as<{
        sku: string;
        value: string;
        days_on_hand: string | null;
        dead: boolean;
        basis_days: number;
      }>(c, chef, 'select * from rpt.stock_items($1)', [ids.node(KITCHEN)]);
      const by = new Map(items.map((i) => [i.sku, i]));
      // the value is the stock levels' value
      const { rows } = await c.query<{ v: string }>(
        `select sum(value) as v from inv.stock_level where delivery_node_id = $1`,
        [ids.node(KITCHEN)],
      );
      expect(s.stock_value).toBe(Number(rows[0]!.v));
      // first used 6 days before the load day: 7 days of use, so days on hand show. Before
      // 06:00 the business day is still yesterday (ADR 023): one day fewer so far
      const lag = (
        await c.query<{ n: number }>(`select current_date - rpt.today($1) as n`, [
          ids.node(KITCHEN),
        ])
      ).rows[0]!.n;
      expect(s.basis_days).toBe(7 - lag);
      expect(by.get('PANEER')!.basis_days).toBe(7 - lag);
      // days on hand need 7 days of use: none yet before 06:00 on the load day
      expect(lag === 0 ? Number(s.days_on_hand) > 0 : s.days_on_hand === null).toBe(true);
      // nothing but opening stock: dead (decided 2 Oct); used this week: not dead
      expect(by.get('MUTTON')!.dead).toBe(true);
      expect(by.get('MUTTON')!.days_on_hand).toBeNull();
      expect(by.get('PANEER')!.dead).toBe(false);
      // bought this week (file 33): moving, so not dead
      expect(by.get('TOMATOES')!.dead).toBe(false);
      const dead = items.filter((i) => i.dead);
      expect(s.dead_items).toBe(dead.length);
      expect(s.dead_value).toBeCloseTo(
        dead.reduce((t, i) => t + Number(i.value), 0),
        2,
      );
    });
  });
});

describe('purchasing (file 33)', () => {
  const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN-STORE';

  it('price changes: tomatoes went up ₹4 twice, against the previous receipt', async () => {
    await inRolledBackTx(async (c) => {
      const w = await window(c);
      const rows = await as<{
        sku: string;
        unit_cost: string;
        previous_cost: string;
        basis: string;
        change_value: string;
      }>(c, 'test.cost-controller.1.0', 'select * from rpt.price_changes($1, $2, $3)', [
        ids.node(KITCHEN),
        w.from28,
        w.to,
      ]);
      expect(
        rows.map((r) => [r.sku, n(r.unit_cost), n(r.previous_cost), r.basis, n(r.change_value)]),
      ).toEqual([
        ['TOMATOES', 44, 40, 'previous', 60],
        ['TOMATOES', 48, 44, 'previous', 60],
        // the first receipt of each item is against its standard cost
        ['TOMATOES', 40, 40, 'standard', 0],
        ['ONIONS', 35, 35, 'standard', 0],
        ['ONIONS', 35, 35, 'previous', 0],
      ]);
    });
  });

  it('supplier fill rate: fresh produce 95.9% with one late order; dairy not delivered', async () => {
    await inRolledBackTx(async (c) => {
      const w = await window(c);
      const p = [ids.node(KITCHEN), w.from28, w.to];
      const fill = await as<{
        supplier: string;
        orders: number;
        ordered_value: string;
        received_value: string;
        fill_pct: string;
        on_time: number;
        late: number;
        not_delivered: number;
      }>(c, 'test.executive-chef.1.0', 'select * from rpt.supplier_fill($1, $2, $3)', p);
      expect(
        fill.map((f) => [
          f.supplier,
          f.orders,
          n(f.ordered_value),
          n(f.received_value),
          n(f.fill_pct),
          f.on_time,
          f.late,
          f.not_delivered,
        ]),
      ).toEqual([
        ['Test Supplier – Dairy & Poultry', 1, 3100, 0, 0, 0, 0, 1],
        ['Test Supplier – Fresh Produce', 3, 3380, 3240, 95.9, 2, 1, 0],
      ]);
      const short = await as<{
        sku: string;
        ordered: string;
        received: string;
        short_value: string;
      }>(c, 'test.executive-chef.1.0', 'select * from rpt.short_deliveries($1, $2, $3)', p);
      expect(short.map((s) => [s.sku, n(s.ordered), n(s.received), n(s.short_value)])).toEqual([
        ['PANEER', 5, 0, 1900],
        ['MILK', 20, 0, 1200],
        ['ONIONS', 20, 16, 140],
      ]);
    });
  });

  it('the orders went through the workflow: ordered by the chef, completed; only the unusual one was approved, by the GM (PO-5)', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{
        key: string;
        state: string;
        initiator: string;
        unusual: string;
        approver: string | null;
      }>(
        `select po.idempotency_key as key, r.state, i.username as initiator,
                r.payload ->> 'unusual' as unusual,
                (select a.username from wf.step_instance s join core.app_user a on a.id = s.actor_id
                  where s.request_id = r.id and s.state = 'approved') as approver
           from inv.purchase_order po
           join wf.request r on r.id = po.wf_request_id
           join core.app_user i on i.id = r.initiator_id
          where po.idempotency_key like 'test-data po %' order by po.idempotency_key`,
      );
      expect(rows).toHaveLength(4);
      // menu items in usual quantities (PO-1 to PO-3): no approval, completed at once;
      // PO-4's 20 litres of milk against a week's use under 1 litre goes to the GM, since the
      // chef is the department head and made it
      expect(rows.map((r) => [r.key, r.state, r.initiator, r.unusual, r.approver])).toEqual([
        ['test-data po PO-1', 'completed', 'test.executive-chef.1.0', 'false', null],
        ['test-data po PO-2', 'completed', 'test.executive-chef.1.0', 'false', null],
        ['test-data po PO-3', 'completed', 'test.executive-chef.1.0', 'false', null],
        [
          'test-data po PO-4',
          'completed',
          'test.executive-chef.1.0',
          'true',
          'test.general-manager.1.0',
        ],
      ]);
    });
  });
});

describe('test-only purchase functions', () => {
  /** The message of a statement's error, or null; the transaction carries on. */
  async function attempt(c: PoolClient, sql: string, params: unknown[]): Promise<string | null> {
    await c.query('savepoint a');
    try {
      await c.query(sql, params);
      await c.query('release savepoint a');
      return null;
    } catch (e) {
      await c.query('rollback to savepoint a');
      return (e as Error).message;
    }
  }

  it('the app cannot call them, or the bodies behind the reports', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        `select inv.record_test_release($1, now())`,
        ['00000000-0000-0000-0000-000000000000'],
      );
      expect(r.error).toMatch(/permission denied/);
      const { rows } = await c.query<{ f: string }>(
        `select p.oid::regprocedure::text as f from pg_proc p
           join pg_namespace s on s.oid = p.pronamespace
          where (s.nspname, p.proname) in (('inv', 'receive_at'), ('inv', 'post_at'),
                  ('inv', 'variance_of'), ('menu', 'cost_calc'), ('inv', 'record_test_release'),
                  ('inv', 'record_test_receipt'), ('inv', 'require_test_time'))
            and has_function_privilege('app_rw', p.oid, 'execute')`,
      );
      expect(rows).toEqual([]);
    });
  });

  it('they refuse a real customer, a future time and an order not yet approved', async () => {
    await inRolledBackTx(async (c) => {
      const chef = ids.user('test.executive-chef.1.0');
      await c.query(`select set_config('app.user_id', $1, true)`, [chef]);
      const po = (
        await c.query<{ id: string }>(
          `select inv.create_po($1, (select id from inv.supplier where tenant_id = $2
                                       order by name limit 1),
                                jsonb_build_array(jsonb_build_object(
                                  'item_id', (select n.item_id from inv.item_node n
                                                 where n.delivery_node_id = $1
                                                   and n.item_id <> all (array(
                                                     select inv.on_menu_items($1)))
                                                 order by n.item_id limit 1),
                                  'qty', 1, 'unit_cost', 40))) as id`,
          [ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'), ids.tenant()],
        )
      ).rows[0]!.id;
      const yesterday = new Date(Date.now() - 86_400_000);
      const tomorrow = new Date(Date.now() + 86_400_000);
      const release = 'select inv.record_test_release($1, $2)';
      expect(await attempt(c, release, [po, yesterday])).toBe('INVALID_STATE');
      expect(await attempt(c, release, [po, tomorrow])).toBe('INVALID_DATE');

      // a customer that isn't a test customer (is_test is fixed when it is created)
      const t = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name, code, is_test) values ('Real Hotels', 'REAL-HOTELS', false)
           returning id`,
        )
      ).rows[0]!.id;
      const u = (
        await c.query<{ id: string }>(
          `insert into core.app_user (tenant_id, kind, display_name, username)
           values ($1, 'human', 'Real Chef', 'real.chef') returning id`,
          [t],
        )
      ).rows[0]!.id;
      await c.query(`select set_config('app.user_id', $1, true)`, [u]);
      expect(await attempt(c, release, [po, yesterday])).toBe('TEST_CUSTOMER_ONLY');
      expect(
        await attempt(c, `select inv.record_test_receipt($1, '[]', $2)`, [po, yesterday]),
      ).toBe('TEST_CUSTOMER_ONLY');
    });
  });
});
