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
