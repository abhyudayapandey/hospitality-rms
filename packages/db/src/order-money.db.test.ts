import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Order values only for cost readers (KI-09): staff who only take in deliveries see what came,
// never what it is worth. Test Hotel 1.0's Kitchen store has file 33's received orders; its
// chef de partie follows them (PURCHASE_ORDERS view), its executive chef keeps the store, the
// cost controller reads its cost and the purchase manager its bills.

const CDP = 'test.chef-de-partie.1.0';
const CHEF = 'test.executive-chef.1.0';
const COST = 'test.cost-controller.1.0';
const BUYER = 'test.purchase-manager.1.0';
const RECEIVERS = [
  ['test.head-bartender.1.0', 'TEST-HOTEL-1.0-BAR-STORE'],
  ['test.laundry-attendant.1.0', 'TEST-HOTEL-1.0-HOUSEKEEPING-STORE'],
  ['test.housekeeping-supervisor.1.0', 'TEST-HOTEL-1.0-HOUSEKEEPING-STORE'],
  [CDP, 'TEST-HOTEL-1.0-KITCHEN-STORE'],
] as const;

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const kitchen = () => ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');

async function one<T = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await attemptAs<T & object>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows[0] as T;
}

/** a received order at the kitchen store (file 33) */
async function receivedOrder(c: PoolClient): Promise<string> {
  const r = await c.query<{ id: string }>(
    `select po.id from inv.purchase_order po
      where po.delivery_node_id = $1
        and exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
      order by po.created_at limit 1`,
    [kitchen()],
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!.id;
}

describe('order values (KI-09)', () => {
  it('a receiver sees the order but not its value; cost and bill readers see it', async () => {
    await inRolledBackTx(async (c) => {
      const po = await receivedOrder(c);
      const seen = await one<{ n: number }>(
        c,
        CDP,
        `select count(*)::int as n from inv.purchase_order_summary where id = $1`,
        [po],
      );
      expect(seen.n).toBe(1);
      const q = `select inv.po_received_value($1) as v, inv.po_sees_money($1) as sees`;
      expect(await one(c, CDP, q, [po])).toEqual({ v: null, sees: false });
      for (const who of [CHEF, COST, BUYER]) {
        const r = await one<{ v: string | null; sees: boolean }>(c, who, q, [po]);
        expect(r.sees, who).toBe(true);
        expect(Number(r.v), who).toBeGreaterThan(0);
      }
    });
  });

  it('staff who only receive at a store do not see its money', async () => {
    await inRolledBackTx(async (c) => {
      for (const [who, store] of RECEIVERS) {
        const r = await one<{ sees: boolean; po: boolean }>(
          c,
          who,
          `select inv.sees_store_money($1) as sees,
                  core.can('PURCHASE_ORDERS', 'view', null, $1) as po`,
          [ids.node(store)],
        );
        expect(r, who).toEqual({ sees: false, po: true });
      }
      const chef = await one<{ sees: boolean }>(
        c,
        CHEF,
        `select inv.sees_store_money($1) as sees`,
        [kitchen()],
      );
      expect(chef.sees).toBe(true);
    });
  });

  it('department heads see their own stores’ money; their staff do not (ADR 145)', async () => {
    await inRolledBackTx(async (c) => {
      const bar = ids.node('TEST-HOTEL-1.0-BAR-STORE');
      const hk = ids.node('TEST-HOTEL-1.0-HOUSEKEEPING-STORE');
      const q = `select inv.sees_store_money($1) as bar, inv.sees_store_money($2) as hk`;
      expect(await one(c, 'test.bar-manager.1.0', q, [bar, hk])).toEqual({ bar: true, hk: false });
      expect(await one(c, 'test.executive-housekeeper.1.0', q, [bar, hk])).toEqual({
        bar: false,
        hk: true,
      });
      for (const who of ['test.housekeeping-supervisor.1.0', 'test.head-bartender.1.0']) {
        expect(await one(c, who, q, [bar, hk]), who).toEqual({ bar: false, hk: false });
      }
      // the cost controller's job is the cost: every store
      expect(await one(c, COST, q, [bar, hk])).toEqual({ bar: true, hk: true });
    });
  });

  it('wastage over the limit still needs a photo for a receiver, worked out on the server', async () => {
    await inRolledBackTx(async (c) => {
      // the threshold is the tenant's: read it as someone there
      await c.query(`select set_config('app.user_id', $1, true)`, [ids.user(CHEF)]);
      const it = (
        await c.query<{ item_id: string; avg: string; limit: string }>(
          `select s.item_id, s.avg_cost as avg, inv.wastage_threshold($1) as limit
             from inv.stock_level s where s.delivery_node_id = $1 and s.avg_cost > 0
              and (s.on_hand - 1) * s.avg_cost > inv.wastage_threshold($1)
            order by s.avg_cost desc limit 1`,
          [kitchen()],
        )
      ).rows[0]!;
      const qty = Math.ceil(Number(it.limit) / Number(it.avg)) + 1;
      const r = await attemptAs(
        c,
        ids.user(CDP),
        `select inv.record_wastage($1, $2::jsonb, null)`,
        [kitchen(), JSON.stringify([{ item_id: it.item_id, qty, reason: 'spoiled' }])],
      );
      expect(r.error).toBe('PHOTO_REQUIRED');
    });
  });
});

describe('money on adjustments and order reasons (ADR 166)', () => {
  it("a chef de partie's wastage adjustment shows them no ₹; the chef and its approver see it", async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`select set_config('app.user_id', $1, true)`, [ids.user(CHEF)]);
      const it = (
        await c.query<{ item_id: string; avg: string; limit: string }>(
          `select s.item_id, s.avg_cost as avg, inv.wastage_threshold($1) as limit
             from inv.stock_level s where s.delivery_node_id = $1 and s.avg_cost > 0
              and (s.on_hand - 1) * s.avg_cost > inv.wastage_threshold($1)
            order by s.avg_cost desc, s.item_id limit 1`,
          [kitchen()],
        )
      ).rows[0]!;
      await c.query(`select set_config('app.user_id', '', true)`);
      const qty = Math.ceil(Number(it.limit) / Number(it.avg)) + 1;
      const photo = `wastage/${ids.tenant()}/${kitchen()}/${crypto.randomUUID()}.jpg`;
      const w = await one<{ id: string }>(
        c,
        CDP,
        `select inv.record_wastage($1, $2::jsonb) as id`,
        [
          kitchen(),
          JSON.stringify([{ item_id: it.item_id, qty, reason: 'spoiled', photo_key: photo }]),
        ],
      );
      const { adj, req } = (
        await c.query<{ adj: string; req: string }>(
          `select a.id as adj, a.wf_request_id as req
             from inv.wastage w join inv.stock_adjustment a on a.id = w.adjustment_id
            where w.id = $1`,
          [w.id],
        )
      ).rows[0]!;
      // the adjustment page's reads
      const page = `
        select a.id, case when inv.sees_adjustment_money(a.id) then a.amount end as amount,
               (select array_agg(case when inv.sees_adjustment_money(a.id) then l.unit_cost end)
                  from inv.stock_adjustment_line l where l.adjustment_id = a.id) as costs
          from inv.stock_adjustment a where a.id = $1`;
      const cdp = await one<{ id: string; amount: string | null; costs: (string | null)[] }>(
        c,
        CDP,
        page,
        [adj],
      );
      expect(cdp).toEqual({ id: adj, amount: null, costs: [null] });
      for (const who of [CHEF, COST]) {
        const r = await one<{ amount: string | null; costs: (string | null)[] }>(c, who, page, [
          adj,
        ]);
        expect(Number(r.amount), who).toBeGreaterThan(0);
        expect(Number(r.costs[0]), who).toBeGreaterThan(0);
      }
      // whoever may approve it sees what they approve
      const approvers = (
        await c.query<{ id: string }>(
          `select u as id from wf.request r, unnest(inv.step_people(r.id, r.current_step)) u
            where r.id = $1`,
          [req],
        )
      ).rows;
      expect(approvers.length).toBeGreaterThan(0);
      for (const a of approvers) {
        const r = await attemptAs<{ sees: boolean }>(
          c,
          a.id,
          'select inv.sees_adjustment_money($1) as sees',
          [adj],
        );
        expect(r.rows?.[0]?.sees).toBe(true);
      }
      // another company never
      const solo = await attemptAs<{ sees: boolean }>(
        c,
        ids.user('test.solo.bar-manager'),
        'select inv.sees_adjustment_money($1) as sees',
        [adj],
      );
      expect(solo.rows?.[0]?.sees).toBe(false);
    });
  });

  it('an order\'s "Worth ₹X" reason reaches its approver and money readers only', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `update core.tenant set settings = settings || '{"purchase_approval": "above:1000"}'
          where id = $1`,
        [ids.tenant()],
      );
      const onions = (
        await c.query<{ id: string }>(
          `select id from inv.item where tenant_id = $1 and sku = 'ONIONS'`,
          [ids.tenant()],
        )
      ).rows[0]!.id;
      const po = await one<{ id: string }>(
        c,
        CHEF,
        `select inv.request_supplies($1, $2::jsonb) as id`,
        [kitchen(), JSON.stringify([{ item_id: onions, qty: 30 }])],
      );
      const q = `select why, may_act from inv.po_approval($1)`;
      expect(await one(c, CHEF, q, [po.id])).toMatchObject({ why: 'Worth ₹1050, above ₹1000' });
      // a chef de partie follows the kitchen's orders but reads no money
      expect(await one(c, CDP, q, [po.id])).toEqual({
        why: 'Over the amount that needs approval',
        may_act: false,
      });
      const approvers = (
        await c.query<{ id: string }>(
          `select u as id from inv.purchase_order p join wf.request r on r.id = p.wf_request_id,
                  unnest(inv.step_people(r.id, r.current_step)) u
            where p.id = $1`,
          [po.id],
        )
      ).rows;
      expect(approvers.length).toBeGreaterThan(0);
      for (const a of approvers) {
        const r = await attemptAs<{ why: string; may_act: boolean }>(c, a.id, q, [po.id]);
        expect(r.rows?.[0]).toEqual({ why: 'Worth ₹1050, above ₹1000', may_act: true });
      }
    });
  });
});
