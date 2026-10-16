import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// One person told to receive (ADR 148): an order to receive is on the To do list of its order
// desk's keepers (Hotel 1.0's Store Keeper, and its Purchase Manager, who keeps the store too).
// The GM, who may also receive, sees it in Orders, not on the To do list. A desk with no keeper:
// everyone who may receive there has it, as before.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

async function receives(username: string): Promise<string[]> {
  return inRolledBackTx(async (c) => {
    const r = await attemptAs<{ store: string }>(
      c,
      ids.user(username),
      `select store from inv.desk_orders() where stage = 'to_receive' order by 1`,
    );
    expect(r.error).toBeUndefined();
    return r.rows!.map((x) => x.store);
  });
}

describe('orders to receive on the To do list', () => {
  it('the store’s keepers have its deliveries to receive', async () => {
    expect((await receives('test.store-keeper.1.0')).length).toBeGreaterThan(0);
    expect((await receives('test.purchase-manager.1.0')).length).toBeGreaterThan(0);
  });

  it('the GM does not, though she may receive', async () => {
    expect(await receives('test.general-manager.1.0')).toEqual([]);
  });

  it('a desk with no keeper: whoever may receive there has them', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `update core.role_assignment set effective_to = current_date - 1
          where user_id = any ($1) and group_id in (select id from core.security_group
                                                     where code = 'STORE_KEEPER')`,
        [[ids.user('test.store-keeper.1.0'), ids.user('test.purchase-manager.1.0')]],
      );
      const gm = await attemptAs<{ store: string }>(
        c,
        ids.user('test.general-manager.1.0'),
        `select store from inv.desk_orders() where stage = 'to_receive'`,
      );
      expect(gm.rows!.length).toBeGreaterThan(0);
    });
  });
});

describe('an order received in part says so (SK-06, ADR 164)', () => {
  it('"Part received" once some of it came, and only then', async () => {
    await inRolledBackTx(async (c) => {
      const keeper = ids.user('test.store-keeper.1.0');
      const desk = async () => {
        const r = await attemptAs<{ po_id: string; part_received: boolean }>(
          c,
          keeper,
          `select po_id::text, part_received from inv.desk_orders() where stage = 'to_receive'`,
        );
        expect(r.error).toBeUndefined();
        return r.rows!;
      };
      const rows = await desk();
      // every row agrees with its receipts
      for (const row of rows) {
        const got = await c.query<{ n: number }>(
          `select count(*)::int n from inv.goods_receipt_line gl
             join inv.purchase_order_line pl on pl.id = gl.po_line_id
            where pl.po_id = $1 and gl.qty > 0`,
          [row.po_id],
        );
        expect(row.part_received, row.po_id).toBe(got.rows[0]!.n > 0);
      }
      // one that nothing came for yet: one of its lines comes, in part
      const none = rows.find((r) => !r.part_received);
      expect(none).toBeDefined();
      const line = await c.query<{ item_id: string; qty: string }>(
        `select item_id::text, qty from inv.purchase_order_line where po_id = $1
          order by id limit 1`,
        [none!.po_id],
      );
      const { item_id, qty } = line.rows[0]!;
      const half = Math.max(Number(qty) / 2, 0.5);
      const got = await attemptAs(c, keeper, `select inv.receive_goods($1, $2::jsonb, null)`, [
        none!.po_id,
        JSON.stringify([{ item_id, qty: half, amount: half * 10 }]),
      ]);
      expect(got.error).toBeUndefined();
      const after = (await desk()).find((r) => r.po_id === none!.po_id);
      expect(after).toEqual({ po_id: none!.po_id, part_received: true });
    });
  });
});
