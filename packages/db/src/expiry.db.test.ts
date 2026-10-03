import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { everyone } from '../test/report-access';

// Expiring and expired stock (INV-12 banners, RPT-14; ADR 033). Dated batches (prep made in
// house, PRD-1) are listed for every store where the person sees stock levels: expired
// (use-by passed) and expiring (use-by on one of the store's next three days, today
// included). Stock position values them at the item's average cost at the store, and opens
// for all of an outlet's stores together.
//
// The test data's batches count from the load day (file 26, README "Batches"): at the Hotel
// 1.0 Kitchen Store, Mint Chutney (140 g) is expired and Ginger Garlic Paste (580 g) is
// still in date, with its use-by three days after the load day.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

interface Batch {
  store_id: string;
  store: string;
  name: string;
  unit: string;
  batch_no: string;
  expires_at: Date;
  remaining: string;
  expired: boolean;
}

const list = (c: PoolClient, user: string, days = 3) =>
  attemptAs<Batch>(c, user, 'select * from inv.expiry_list($1)', [days]);

const measures = async (c: PoolClient, user: string, place: string) => {
  const r = await attemptAs<{ measure: string; value: string | null }>(
    c,
    ids.user(user),
    'select measure, value::text from rpt.stock_summary($1)',
    [ids.node(place)],
  );
  if (r.error !== undefined) throw new Error(r.error);
  return Object.fromEntries(r.rows.map((x) => [x.measure, x.value]));
};

describe('the expiry list (INV-12)', () => {
  it('the executive chef sees their kitchen store’s batches: expired and expiring', async () => {
    await inRolledBackTx(async (c) => {
      const r = await list(c, ids.user('test.executive-chef.1.0'));
      expect(r.error).toBeUndefined();
      const rows = r.rows!.map((b) => [b.store, b.name, b.remaining, b.expired]);
      expect(rows).toEqual(
        expect.arrayContaining([
          ['Test Hotel & Bar 1.0 – Kitchen Store', 'Mint Chutney', '140.000000', true],
          ['Test Hotel & Bar 1.0 – Kitchen Store', 'Ginger Garlic Paste', '580.000000', false],
        ]),
      );
      expect(new Set(r.rows!.map((b) => b.store))).toEqual(
        new Set(['Test Hotel & Bar 1.0 – Kitchen Store']),
      );
    });
  });

  it('every user: exactly the dated batches at stores where they see stock levels', async () => {
    await inRolledBackTx(async (c) => {
      const wrong: string[] = [];
      let some = 0;
      for (const p of await everyone(c)) {
        const r = await list(c, p.id);
        if (r.error !== undefined) {
          wrong.push(`${p.username}: ${r.error}`);
          continue;
        }
        if (r.rows.length > 0) some++;
        // independently: batches with stock left at the stores they may view, expired or with
        // a use-by date (store time) no later than three days from today there
        await c.query(`select set_config('app.user_id', $1, true)`, [p.id]);
        const want = await c.query<{ k: string }>(
          `select n.id || ' ' || b.batch_no || ' ' || x.item_id as k
             from core.hierarchy_node n
             join inv.item_node x on x.delivery_node_id = n.id and x.archived_at is null
             cross join lateral inv.batch_rows(x.item_id, n.id) b
            where n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.holds_stock
              and n.archived_at is null
              and core.can('STOCK_LEVELS', 'view', null, n.id)
              and b.remaining > 0
              and (b.expires_at <= now()
                   or (b.expires_at at time zone coalesce(ops.tz_of(n.id), 'UTC'))::date
                        <= (now() at time zone coalesce(ops.tz_of(n.id), 'UTC'))::date + 3)
            order by 1`,
        );
        const gotKeys = await c.query<{ k: string }>(
          `select l.store_id || ' ' || l.batch_no || ' ' || l.item_id as k
             from jsonb_to_recordset($1::jsonb) as l(store_id uuid, batch_no text, item_id uuid)
            order by 1`,
          [JSON.stringify(r.rows)],
        );
        await c.query(`select set_config('app.user_id', '', true)`);
        const got = gotKeys.rows.map((x) => x.k);
        const exp = want.rows.map((x) => x.k);
        if (JSON.stringify(got) !== JSON.stringify(exp)) {
          wrong.push(`${p.username}: got ${got.length}, want ${exp.length}`);
        }
      }
      expect(wrong).toEqual([]);
      expect(some).toBeGreaterThan(5);
    });
  }, 180_000);

  it('a server without stock access gets an empty list; another customer sees none of it', async () => {
    await inRolledBackTx(async (c) => {
      const server = await list(c, ids.user('test.server.3.0'));
      expect(server.rows).toEqual([]);
      const solo = await list(c, ids.user('test.solo.bar-manager'));
      expect(solo.error).toBeUndefined();
      expect(solo.rows!.filter((b) => !b.store.startsWith('Test Solo Bar'))).toEqual([]);
    });
  });

  it('looks ahead 0 to 14 days only', async () => {
    await inRolledBackTx(async (c) => {
      const chef = ids.user('test.executive-chef.1.0');
      expect((await list(c, chef, -1)).error).toBe('INVALID_DAYS');
      expect((await list(c, chef, 15)).error).toBe('INVALID_DAYS');
      const today = await list(c, chef, 0);
      // day 0: only what has already expired (the paste's use-by is three days out)
      expect(today.rows!.map((b) => b.name)).toEqual(['Mint Chutney']);
    });
  });
});

describe('stock position: expired and expiring values (RPT-14)', () => {
  it('values a store’s expired and expiring batches at the item’s average cost', async () => {
    await inRolledBackTx(async (c) => {
      const m = await measures(c, 'test.cost-controller.1.0', 'TEST-HOTEL-1.0-KITCHEN-STORE');
      expect(m.expired_stock_value).toBe('25.13');
      // Ginger Garlic Paste: all 580 g on hand, ₹101.33
      expect(m.expiring_stock_value).toBe('101.33');
      const items = await attemptAs<{
        name: string;
        expired_value: string;
        expiring_value: string;
      }>(
        c,
        ids.user('test.cost-controller.1.0'),
        `select name, expired_value::text, expiring_value::text from rpt.stock_items($1)
          where expired_value > 0 or expiring_value > 0 order by name`,
        [ids.node('TEST-HOTEL-1.0-KITCHEN-STORE')],
      );
      expect(items.rows).toEqual([
        { name: 'Ginger Garlic Paste', expired_value: '0.00', expiring_value: '101.33' },
        { name: 'Mint Chutney', expired_value: '25.13', expiring_value: '0.00' },
      ]);
    });
  });
});

describe('stock position for all of an outlet’s stores (RPT-14)', () => {
  it('adds up the stores the person opens; names the store on each item', async () => {
    await inRolledBackTx(async (c) => {
      const cc = 'test.cost-controller.1.0';
      const all = await measures(c, cc, 'TEST-HOTEL-1.0-SUPPLY');
      const places = await attemptAs<{ id: string; code: string }>(
        c,
        ids.user(cc),
        `select p.id, p.code from rpt.report_places('stock_position') p where p.kind = 'store'`,
      );
      const site = await c.query<{ id: string }>(
        `select p.id from jsonb_to_recordset($1::jsonb) as p(id uuid)
          where core.stock_site(p.id) = $2`,
        [JSON.stringify(places.rows), ids.node('TEST-HOTEL-1.0-SUPPLY')],
      );
      const stores = places.rows!.filter((p) => site.rows.some((s) => s.id === p.id));
      expect(stores.length).toBeGreaterThan(1);
      const sum = {
        stock_value: 0,
        expired_stock_value: 0,
        expiring_stock_value: 0,
        dead_items: 0,
      };
      for (const s of stores) {
        const m = await measures(c, cc, s.code);
        for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += Number(m[k]);
      }
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) {
        expect(Number(all[k]), k).toBeCloseTo(sum[k], 2);
      }
      const items = await attemptAs<{ store: string }>(
        c,
        ids.user(cc),
        'select distinct store from rpt.stock_items($1) order by store',
        [ids.node('TEST-HOTEL-1.0-SUPPLY')],
      );
      expect(items.rows!.length).toBe(stores.length);
    });
  });

  it('refused to someone who opens only one of the stores, and across customers', async () => {
    await inRolledBackTx(async (c) => {
      for (const [user, place] of [
        ['test.executive-chef.1.0', 'TEST-HOTEL-1.0-SUPPLY'],
        ['test.solo.bar-manager', 'TEST-HOTEL-1.0-SUPPLY'],
        ['test.cost-controller.1.0', 'TEST-HOTEL-1.1-SUPPLY'],
      ] as const) {
        for (const fn of ['rpt.stock_summary($1)', 'rpt.stock_items($1)']) {
          const r = await attemptAs(c, ids.user(user), `select * from ${fn}`, [ids.node(place)]);
          expect(r.error, `${user} ${fn}`).toBe('NOT_AUTHORISED');
        }
      }
    });
  });
});
