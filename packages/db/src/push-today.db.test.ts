import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Expiry alerts and dishes to push (INV-12, ADR 040). Each morning the team that uses a
// store hears about the prep about to expire there, with the dishes that use it up; the
// outlet's people see "Push today" with those dishes. Only what expires by the end of
// tomorrow's business day and still has stock; expired batches go to the discard flow.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const STORE = 'TEST-BAR-3.0-KITCHEN-STORE';

/** A batch of ginger garlic paste at Test Bar 3.0's kitchen store, expiring in `hours`. */
async function batch(c: PoolClient, hours: number, qty = 500, batchNo = 'SOON-1') {
  await c.query(
    `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                   unit_cost, ref_type, batch_no, expires_at, occurred_at)
     select i.tenant_id, i.id, $1, 'production_in', $2, 0.2, 'production', $3,
            now() + make_interval(hours => $4), now() - interval '1 hour'
       from inv.item i where i.tenant_id = $5 and i.sku = 'GINGER-GARLIC-PASTE'`,
    [ids.node(STORE), qty, batchNo, hours, ids.tenant()],
  );
}

interface Push {
  dish: string;
  item: string;
  expires_at: string;
}
const push = (c: PoolClient, who: string, outlet: string) =>
  attemptAs<Push>(c, ids.user(who), 'select * from menu.push_today($1)', [ids.node(outlet)]);

describe('Push today', () => {
  it('lists the dishes that use prep expiring by tomorrow, for the outlet’s people', async () => {
    await inRolledBackTx(async (c) => {
      const before = await push(c, 'test.server.3.0', 'TEST-BAR-3.0');
      expect(before.error).toBeUndefined();
      expect(before.rows!.filter((r) => r.item === 'Ginger Garlic Paste')).toEqual([]);
      await batch(c, 20);
      const after = await push(c, 'test.server.3.0', 'TEST-BAR-3.0');
      const dishes = after.rows!.filter((r) => r.item === 'Ginger Garlic Paste').map((r) => r.dish);
      // Test Bar 3.0 sells these two from its kitchen store; both use the paste
      expect(dishes.sort()).toEqual(['Paneer Tikka', 'Prawns Masala']);
      // the cashier, a bartender and the bar manager see it too
      for (const who of ['test.cashier.3.0', 'test.bartender.3.0', 'test.bar-manager.3.0']) {
        const r = await push(c, who, 'TEST-BAR-3.0');
        expect(
          r.rows!.some((x) => x.dish === 'Paneer Tikka'),
          who,
        ).toBe(true);
      }
    });
  });

  it('only dishes that use it themselves, not through another prep', async () => {
    await inRolledBackTx(async (c) => {
      // Mojito and Espresso Martini use Sugar Syrup; Whisky Sour uses Sour Mix, which is
      // made from it: selling Whisky Sour uses up Sour Mix, not the syrup
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                       unit_cost, ref_type, batch_no, expires_at, occurred_at)
         select i.tenant_id, i.id, $1, 'production_in', 1000, 0.1, 'production', 'SOON-2',
                now() + interval '10 hours', now() - interval '1 hour'
           from inv.item i where i.tenant_id = $2 and i.sku = 'SUGAR-SYRUP'`,
        [ids.node('TEST-BAR-3.0-BAR-STORE'), ids.tenant()],
      );
      const r = await push(c, 'test.server.3.0', 'TEST-BAR-3.0');
      const dishes = r.rows!.filter((x) => x.item.startsWith('Sugar Syrup')).map((x) => x.dish);
      expect(dishes.sort()).toEqual(['Espresso Martini', 'Mojito']);
    });
  });

  it('leaves out expired batches, empty ones and those expiring later', async () => {
    await inRolledBackTx(async (c) => {
      // a use-by is a date: gone only once its business day has ended, so a day and an hour ago
      await batch(c, -25, 500, 'GONE-1');
      await batch(c, 24 * 4, 500, 'LATER-1');
      const r = await push(c, 'test.server.3.0', 'TEST-BAR-3.0');
      expect(r.rows!.filter((x) => x.item === 'Ginger Garlic Paste')).toEqual([]);
    });
  });

  it('only for people at the outlet', async () => {
    await inRolledBackTx(async (c) => {
      await batch(c, 20);
      expect((await push(c, 'test.server.3.0', 'TEST-HOTEL-1.0')).error).toMatch(/NOT_AUTHORISED/);
      expect((await push(c, 'test.steward.1.0', 'TEST-BAR-3.0')).error).toMatch(/NOT_AUTHORISED/);
      expect((await push(c, 'test.solo.bartender', 'TEST-BAR-3.0')).error).toMatch(
        /NOT_AUTHORISED/,
      );
      // the area manager above it may look
      expect((await push(c, 'test.area-manager', 'TEST-BAR-3.0')).error).toBeUndefined();
    });
  });
});

describe("Home's Push today card", () => {
  it('at their own outlet, for its service teams and managers, not its kitchen', async () => {
    await inRolledBackTx(async (c) => {
      await batch(c, 20);
      const mine = (who: string) =>
        attemptAs<Push & { outlet_id: string }>(
          c,
          ids.user(who),
          'select * from menu.my_push_today()',
        );
      for (const who of [
        'test.server.3.0',
        'test.cashier.3.0',
        'test.bartender.3.0',
        'test.bar-manager.3.0',
      ]) {
        const r = await mine(who);
        expect(r.error, who).toBeUndefined();
        expect(
          r.rows!.some(
            (x) => x.dish === 'Paneer Tikka' && x.outlet_id === ids.node('TEST-BAR-3.0'),
          ),
          who,
        ).toBe(true);
      }
      expect((await mine('test.cook.3.0')).rows).toEqual([]);
      expect((await mine('test.steward.1.0')).rows!.some((x) => x.dish === 'Paneer Tikka')).toBe(
        false,
      );
    });
  });
});

describe('the morning expiry alert', () => {
  const alerts = async (c: PoolClient) => {
    await c.query('set local role wf_executor');
    const { rows } = await c.query<{ n: number }>('select ops.expiry_alerts() as n');
    await c.query('reset role');
    return rows[0]!.n;
  };
  const inbox = async (c: PoolClient, who: string) => {
    const { rows } = await c.query<{ title: string; body: string; link: string }>(
      `select title, body, link from ops.notification where owner_user_id = $1 and kind = 'expiry_soon'`,
      [ids.user(who)],
    );
    return rows;
  };

  it("tells the store's team leads once a day, with the dishes that use it up", async () => {
    await inRolledBackTx(async (c) => {
      await batch(c, 20);
      expect(await alerts(c)).toBeGreaterThan(0);
      const got = await inbox(c, 'test.head-cook.3.0');
      expect(got).toHaveLength(1);
      expect(got[0]!.title).toMatch(/Use first/);
      expect(got[0]!.body).toMatch(/Ginger Garlic Paste/);
      expect(got[0]!.body).toMatch(/Paneer Tikka/);
      expect(got[0]!.link).toBe(`/stock/expiry?node=${ids.node(STORE)}`);
      // not the cooks or the servers
      expect(await inbox(c, 'test.cook.3.0')).toEqual([]);
      expect(await inbox(c, 'test.server.3.0')).toEqual([]);
      // once a day
      expect(await alerts(c)).toBe(0);
      expect(await inbox(c, 'test.head-cook.3.0')).toHaveLength(1);
    });
  });

  it('only the scheduled job sends it', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(c, ids.user('test.head-cook.3.0'), 'select ops.expiry_alerts()');
      expect(r.error).toMatch(/permission denied/);
    });
  });
});
