import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Shelf life & labels and Breakage (ADR 093): an opened pack of milk keeps 48 hours, shows in
// Expiring and Expired and is thrown away as expired wastage; a torn bath towel leaves the
// housekeeping store, and every department head of the outlet reads the outlet's breakage.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const KITCHEN_STORE = 'TEST-HOTEL-1.0-KITCHEN-STORE';
const HK = 'TEST-HOTEL-1.0-HOUSEKEEPING';
const HK_STORE = 'TEST-HOTEL-1.0-HOUSEKEEPING-STORE';
const OUTLET = 'TEST-HOTEL-1.0';

async function run<T extends object = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  sql: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, ids.user(who), sql, params);
  if (r.error) throw new Error(`${who}: ${r.error}`);
  return r.rows!;
}

const item = async (c: PoolClient, sku: string) =>
  (
    await c.query<{ id: string }>(`select id from inv.item where tenant_id = $1 and sku = $2`, [
      ids.tenant(),
      sku,
    ])
  ).rows[0]!.id;

const onHand = async (c: PoolClient, sku: string, store: string) =>
  Number(
    (
      await c.query<{ n: string }>(`select inv.on_hand($1, $2) as n`, [
        await item(c, sku),
        ids.node(store),
      ])
    ).rows[0]!.n,
  );

const blockOff = (c: PoolClient, block: string) =>
  c.query(
    `update core.tenant set settings = jsonb_set(settings, '{modules}',
       coalesce(settings -> 'modules', '{}') || jsonb_build_object($2::text, false)) where id = $1`,
    [ids.tenant(), block],
  );

describe('opened packs', () => {
  it('opening keeps the stock and dates the pack; its label says what it is', async () => {
    await inRolledBackTx(async (c) => {
      const milk = await item(c, 'MILK');
      const before = await onHand(c, 'MILK', KITCHEN_STORE);
      const [p] = await run<{ id: string }>(
        c,
        'test.chef-de-partie.1.0',
        `select inv.open_pack($1, $2, 1, 'k1') as id`,
        [ids.node(KITCHEN_STORE), milk],
      );
      // the same key gives the same pack
      const [again] = await run<{ id: string }>(
        c,
        'test.chef-de-partie.1.0',
        `select inv.open_pack($1, $2, 1, 'k1') as id`,
        [ids.node(KITCHEN_STORE), milk],
      );
      expect(again!.id).toBe(p!.id);
      expect(await onHand(c, 'MILK', KITCHEN_STORE)).toBe(before);
      const hours = await c.query<{ h: number }>(
        `select extract(epoch from use_by - opened_at) / 3600 as h from inv.opened_pack where id = $1`,
        [p!.id],
      );
      expect(Number(hours.rows[0]!.h)).toBe(48);

      const [label] = await run<{
        name: string;
        food_type: string;
        allergens: string[];
        storage: string;
        opened_by: string;
      }>(
        c,
        'test.chef-de-partie.1.0',
        `select name, food_type, allergens, storage, opened_by from inv.pack_label($1)`,
        [p!.id],
      );
      expect(label).toEqual({
        name: 'Test Milk',
        food_type: 'veg',
        allergens: ['milk'],
        storage: 'chilled',
        opened_by: 'Test Chef de Partie 1.0',
      });

      const expiring = await run<{ pack_id: string; expired: boolean; remaining: string }>(
        c,
        'test.chef-de-partie.1.0',
        `select pack_id, expired, remaining from inv.expiry_list(3) where pack_id is not null`,
      );
      expect(expiring).toEqual([{ pack_id: p!.id, expired: false, remaining: '1.000000' }]);
    });
  });

  it('only for items with a shelf life once opened, no more than the store has, by its users', async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node(KITCHEN_STORE);
      const onions = await attemptAs(
        c,
        ids.user('test.chef-de-partie.1.0'),
        `select inv.open_pack($1, $2, 1)`,
        [store, await item(c, 'ONIONS')],
      );
      expect(onions.error).toMatch(/INVALID_VALUE/);
      const tooMuch = await attemptAs(
        c,
        ids.user('test.chef-de-partie.1.0'),
        `select inv.open_pack($1, $2, 100000)`,
        [store, await item(c, 'MILK')],
      );
      expect(tooMuch.error).toMatch(/INSUFFICIENT_STOCK/);
      // housekeeping uses its own store, not the kitchen's
      const other = await attemptAs(
        c,
        ids.user('test.housekeeping-supervisor.1.0'),
        `select inv.open_pack($1, $2, 1)`,
        [store, await item(c, 'MILK')],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it("a commis opens packs in the kitchen's store, with no other stock access (ADR 097)", async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node(KITCHEN_STORE);
      const items = await run<{ name: string; hours: number }>(
        c,
        'test.commis.1.0',
        `select name, hours from inv.pack_items($1)`,
        [store],
      );
      expect(items.map((i) => i.name)).toEqual([
        'Test Fresh Cream',
        'Test Milk',
        'Test Tomato Ketchup',
      ]);
      const [p] = await run<{ id: string }>(
        c,
        'test.commis.1.0',
        `select inv.open_pack($1, $2, 1) as id`,
        [store, await item(c, 'MILK')],
      );
      const packs = await run<{ id: string }>(
        c,
        'test.commis.1.0',
        `select id from inv.open_packs($1)`,
        [store],
      );
      expect(packs.map((x) => x.id)).toContain(p!.id);
      // still no stock levels, counts or other stores
      const levels = await run(
        c,
        'test.commis.1.0',
        `select 1 from inv.stock_level where delivery_node_id = $1`,
        [store],
      );
      expect(levels).toEqual([]);
      for (const sql of [
        `select inv.pack_items($1)`,
        `select inv.open_pack($1, (select id from inv.item where sku = 'ORANGE-JUICE' and tenant_id = core.my_tenant()), 1)`,
      ]) {
        const r = await attemptAs(c, ids.user('test.commis.1.0'), sql, [
          ids.node('TEST-HOTEL-1.0-BAR-STORE'),
        ]);
        expect(r.error, sql).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('the Opened screen offers only stores that keep something with a shelf life once opened', async () => {
    await inRolledBackTx(async (c) => {
      const places = await run<{ code: string }>(
        c,
        'test.general-manager.1.0',
        `select code from core.screen_places('opened') where code like 'TEST-HOTEL-1.0-%' order by code`,
      );
      expect(places.map((p) => p.code)).toEqual([
        'TEST-HOTEL-1.0-BAR-STORE',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
        'TEST-HOTEL-1.0-MAIN-STORE',
      ]);
      const commis = await run<{ code: string }>(
        c,
        'test.commis.1.0',
        `select code from core.screen_places('opened')`,
      );
      expect(commis.map((p) => p.code)).toEqual([KITCHEN_STORE]);
    });
  });

  it('past its use-by it is expired; thrown away it is expired wastage, once', async () => {
    await inRolledBackTx(async (c) => {
      const milk = await item(c, 'MILK');
      const before = await onHand(c, 'MILK', KITCHEN_STORE);
      const [p] = await run<{ id: string }>(
        c,
        'test.chef-de-partie.1.0',
        `select inv.open_pack($1, $2, 1) as id`,
        [ids.node(KITCHEN_STORE), milk],
      );
      await c.query(
        `update inv.opened_pack set opened_at = now() - interval '3 days',
                use_by = now() - interval '1 day' where id = $1`,
        [p!.id],
      );
      const expired = await run<{ expired: boolean }>(
        c,
        'test.sous-chef.1.0',
        `select expired from inv.expiry_list(3) where pack_id = $1`,
        [p!.id],
      );
      expect(expired).toEqual([{ expired: true }]);

      await run(c, 'test.sous-chef.1.0', `select inv.throw_pack($1)`, [p!.id]);
      expect(await onHand(c, 'MILK', KITCHEN_STORE)).toBe(before - 1);
      const line = await c.query<{ reason: string; qty: string }>(
        `select l.reason, l.qty from inv.opened_pack p
           join inv.wastage_line l on l.wastage_id = p.wastage_id where p.id = $1`,
        [p!.id],
      );
      expect(line.rows).toEqual([{ reason: 'expired', qty: '1.000' }]);
      const twice = await attemptAs(
        c,
        ids.user('test.sous-chef.1.0'),
        `select inv.finish_pack($1)`,
        [p!.id],
      );
      expect(twice.error).toMatch(/INVALID_STATE/);
      const gone = await run(
        c,
        'test.sous-chef.1.0',
        `select 1 from inv.expiry_list(3) where pack_id = $1`,
        [p!.id],
      );
      expect(gone).toEqual([]);
    });
  });

  it('used up: nothing leaves the store', async () => {
    await inRolledBackTx(async (c) => {
      const before = await onHand(c, 'MILK', KITCHEN_STORE);
      const [p] = await run<{ id: string }>(
        c,
        'test.chef-de-partie.1.0',
        `select inv.open_pack($1, $2, 1) as id`,
        [ids.node(KITCHEN_STORE), await item(c, 'MILK')],
      );
      await run(c, 'test.chef-de-partie.1.0', `select inv.finish_pack($1)`, [p!.id]);
      expect(await onHand(c, 'MILK', KITCHEN_STORE)).toBe(before);
      const open = await run(c, 'test.chef-de-partie.1.0', `select id from inv.open_packs($1)`, [
        ids.node(KITCHEN_STORE),
      ]);
      expect(open).toEqual([]);
    });
  });

  it('while the block is off, packs are neither opened nor shown', async () => {
    await inRolledBackTx(async (c) => {
      const [p] = await run<{ id: string }>(
        c,
        'test.chef-de-partie.1.0',
        `select inv.open_pack($1, $2, 1) as id`,
        [ids.node(KITCHEN_STORE), await item(c, 'MILK')],
      );
      await blockOff(c, 'shelf_life');
      const shown = await run(
        c,
        'test.chef-de-partie.1.0',
        `select 1 from inv.expiry_list(3) where pack_id = $1`,
        [p!.id],
      );
      expect(shown).toEqual([]);
      const open = await attemptAs(
        c,
        ids.user('test.chef-de-partie.1.0'),
        `select inv.open_pack($1, $2, 1)`,
        [ids.node(KITCHEN_STORE), await item(c, 'MILK')],
      );
      expect(open.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});

// this business month at Hotel 1.0, worked out as the test's own role
const thisMonth = async (c: PoolClient) =>
  (
    await c.query<{ m: string }>(
      `select date_trunc('month', rpt.business_date(now(), ops.tz_of($1)))::date::text as m`,
      [ids.node(OUTLET)],
    )
  ).rows[0]!.m;

describe('breakage', () => {
  const towel = (c: PoolClient, who: string, extra: { place?: string; store?: string } = {}) =>
    item(c, 'BATH-TOWEL').then((t) =>
      attemptAs<{ id: string }>(
        c,
        ids.user(who),
        `select inv.record_breakage($1, $2, $3, 1, 'worn_out', 'staff', $4, 'torn hem') as id`,
        [
          ids.node(extra.place ?? HK),
          ids.node(extra.store ?? HK_STORE),
          t,
          ids.user('test.room-attendant-b.1.0'),
        ],
      ),
    );

  it('leaves the store through the ledger at its average cost', async () => {
    await inRolledBackTx(async (c) => {
      const before = await onHand(c, 'BATH-TOWEL', HK_STORE);
      const r = await towel(c, 'test.room-attendant.1.0');
      expect(r.error).toBeUndefined();
      const id = r.rows![0]!.id;
      expect(await onHand(c, 'BATH-TOWEL', HK_STORE)).toBe(before - 1);
      const l = await c.query<{ movement_type: string; reason: string; worth: string }>(
        `select l.movement_type, l.reason, (-l.qty * l.unit_cost)::numeric(14,2)::text as worth
           from inv.stock_ledger l where l.ref_type = 'breakage' and l.ref_id = $1`,
        [id],
      );
      const b = await c.query<{ value: string }>(
        `select value::text from inv.breakage where id = $1`,
        [id],
      );
      expect(l.rows).toEqual([
        { movement_type: 'consumption', reason: 'breakage', worth: b.rows[0]!.value },
      ]);
    });
  });

  it("written at one's own department, from a store of its outlet", async () => {
    await inRolledBackTx(async (c) => {
      const steward = await towel(c, 'test.steward.1.0');
      expect(steward.error).toMatch(/NOT_AUTHORISED/);
      const otherOutlet = await towel(c, 'test.room-attendant.1.0', {
        store: 'TEST-HOTEL-1.1-HOUSEKEEPING-STORE',
      });
      expect(otherOutlet.error).toMatch(/NOT_FOUND/);
    });
  });

  it("every department head reads the outlet's breakage; staff read their department's", async () => {
    await inRolledBackTx(async (c) => {
      await towel(c, 'test.room-attendant.1.0');
      const month = await thisMonth(c);
      for (const head of [
        'test.restaurant-manager.1.0',
        'test.executive-chef.1.0',
        'test.executive-housekeeper.1.0',
        'test.general-manager.1.0',
      ]) {
        const log = await run<{ item: string; person: string }>(
          c,
          head,
          `select item, person from inv.breakage_log($1, $2)`,
          [ids.node(OUTLET), month],
        );
        expect(log, head).toContainEqual({
          item: 'Test Bath Towel',
          person: 'Test Room Attendant B 1.0',
        });
      }
      const steward = await attemptAs(
        c,
        ids.user('test.steward.1.0'),
        `select * from inv.breakage_log($1, $2)`,
        [ids.node(OUTLET), month],
      );
      expect(steward.error).toMatch(/NOT_AUTHORISED/);
      const own = await run(
        c,
        'test.room-attendant.1.0',
        `select 1 from inv.breakage_log($1, $2)`,
        [ids.node(HK), month],
      );
      expect(own.length).toBeGreaterThan(0);
    });
  });

  it("the month's total is its log's", async () => {
    await inRolledBackTx(async (c) => {
      await towel(c, 'test.room-attendant.1.0');
      await towel(c, 'test.housekeeping-supervisor.1.0');
      const month = await thisMonth(c);
      const [m] = await run<{ entries: number; value: string }>(
        c,
        'test.general-manager.1.0',
        `select entries, value::text from inv.breakage_months($1) where month = $2`,
        [ids.node(OUTLET), month],
      );
      const [l] = await run<{ n: number; v: string }>(
        c,
        'test.general-manager.1.0',
        `select count(*)::int as n, sum(value)::text as v from inv.breakage_log($1, $2)`,
        [ids.node(OUTLET), month],
      );
      expect(m).toEqual({ entries: l!.n, value: l!.v });
      expect(l!.n).toBe(2);
    });
  });
});
