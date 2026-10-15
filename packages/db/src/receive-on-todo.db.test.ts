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
