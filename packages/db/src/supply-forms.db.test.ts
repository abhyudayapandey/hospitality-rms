import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// UX audit 3, P2 (ADR 053): asking for supplies says who orders them, and Send stock shows
// what the department has and keeps, its short items first. Test Hotel 1.0 has a Main Store;
// Test Bar 3.0 has none, so its stores order for themselves.

const KEEPER = 'test.store-keeper.1.0';
const CHEF = 'test.executive-chef.1.0';
const OUTSIDER = 'test.solo.bar-manager'; // another company

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function one<T>(c: PoolClient, who: string, text: string, params: unknown[]): Promise<T> {
  const r = await attemptAs<T & object>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows[0] as T;
}

describe('who orders a store’s supplies', () => {
  it('the outlet’s Main Store for a department; nobody else for the Main Store or a bar with none', async () => {
    await inRolledBackTx(async (c) => {
      const desk = (node: string, who = CHEF) =>
        one<{ name: string | null }>(c, who, `select inv.order_desk_name($1) as name`, [
          ids.node(node),
        ]).then((r) => r.name);
      expect(await desk('TEST-HOTEL-1.0-KITCHEN-STORE')).toBe('Test Hotel & Bar 1.0 – Main Store');
      expect(await desk('TEST-HOTEL-1.0-MAIN-STORE', KEEPER)).toBeNull();
      expect(await desk('TEST-BAR-3.0-KITCHEN-STORE')).toBeNull();
      // another company's store names nothing
      expect(await desk('TEST-HOTEL-1.0-KITCHEN-STORE', OUTSIDER)).toBeNull();
    });
  });
});

describe('Send stock shows the department’s stock', () => {
  it('has and keeps for each item, the short ones first within the group', async () => {
    await inRolledBackTx(async (c) => {
      const main = ids.node('TEST-HOTEL-1.0-MAIN-STORE');
      const kitchen = ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
      // one kitchen item well under its keep level
      const item = (
        await c.query<{ id: string }>(
          `select n.item_id as id from inv.item_node n
             join inv.item_node m on m.item_id = n.item_id and m.delivery_node_id = $2
            where n.delivery_node_id = $1 and n.archived_at is null order by n.item_id limit 1`,
          [kitchen, main],
        )
      ).rows[0]!.id;
      await c.query(
        `update inv.item_node set par_level = 1000000 where item_id = $1 and delivery_node_id = $2`,
        [item, kitchen],
      );
      const r = await attemptAs<{
        item_id: string;
        item_group: string;
        to_on_hand: string;
        to_keep: string;
      }>(c, ids.user(KEEPER), `select * from inv.send_items($1, $2)`, [main, kitchen]);
      expect(r.error).toBeUndefined();
      const rows = r.rows ?? [];
      const row = rows.find((x) => x.item_id === item)!;
      expect(Number(row.to_keep)).toBe(1000000);
      const onHand = (
        await c.query<{ q: string | null }>(
          `select on_hand as q from inv.stock_level where item_id = $1 and delivery_node_id = $2`,
          [item, kitchen],
        )
      ).rows[0]?.q;
      expect(Number(row.to_on_hand)).toBe(Number(onHand ?? 0));
      // short first within its group
      const group = rows.filter((x) => x.item_group === row.item_group);
      const short = (x: { to_on_hand: string; to_keep: string }) =>
        Number(x.to_keep) > 0 && Number(x.to_on_hand) < Number(x.to_keep);
      const firstNotShort = group.findIndex((x) => !short(x));
      const lastShort = group.map(short).lastIndexOf(true);
      expect(lastShort === -1 || firstNotShort === -1 || lastShort < firstNotShort).toBe(true);
      expect(short(row)).toBe(true);
      // the chef does not send from the Main Store
      const chef = await attemptAs(c, ids.user(CHEF), `select * from inv.send_items($1, $2)`, [
        main,
        kitchen,
      ]);
      expect(chef.rows ?? []).toEqual([]);
    });
  });
});
