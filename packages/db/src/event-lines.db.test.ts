import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Everyone who works an event sees what it needs by name and unit (ADR 098): a banquet server
// holds no stock access, so the item's name comes from ops.event_item_names, which checks the
// event, not the stock.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const names = `select item_id::text, name, base_uom from ops.event_item_names($1) order by name`;

describe('ops.event_item_names', () => {
  it("gives the event's items to whoever sees the event, and to no one else", async () => {
    await inRolledBackTx(async (c) => {
      const tenant = (
        await c.query<{ tenant_id: string }>(
          `select tenant_id from core.hierarchy_node where id = $1`,
          [ids.node('TEST-HOTEL-1.0')],
        )
      ).rows[0]!.tenant_id;
      const { rows: made } = await c.query<{ id: string }>(
        `insert into inv.item (tenant_id, sku, name, category, base_uom)
         values ($1, 'EVL-1', 'Banquet napkin', 'Linen', 'each'),
                ($1, 'EVL-2', 'Paneer', 'Dairy', 'kg') returning id`,
        [tenant],
      );
      const lines = JSON.stringify([
        { kind: 'item', item_id: made[0]!.id, qty: 40 },
        { kind: 'item', item_id: made[1]!.id, qty: 3 },
      ]);
      const ev = await attemptAs<{ id: string }>(
        c,
        ids.user('test.banquet-manager.1.0'),
        `select ops.upsert_event(null, $1, 'Gala dinner', '2026-12-12T13:00:00Z'::timestamptz,
                                 '2026-12-12T16:00:00Z'::timestamptz, 60, null, $2::jsonb,
                                 'planned', null) as id`,
        [ids.node('TEST-HOTEL-1.0'), lines],
      );
      expect(ev.error).toBeUndefined();
      const id = ev.rows![0]!.id;

      // the banquet server cannot read the items themselves
      const direct = await attemptAs<{ n: number }>(
        c,
        ids.user('test.banquet-server.1.0'),
        `select count(*)::int n from inv.item where id = any($1::uuid[])`,
        [[made[0]!.id, made[1]!.id]],
      );
      expect(direct.rows![0]!.n).toBe(0);

      const seen = await attemptAs<{ item_id: string; name: string; base_uom: string }>(
        c,
        ids.user('test.banquet-server.1.0'),
        names,
        [id],
      );
      expect(seen.error).toBeUndefined();
      expect(seen.rows).toEqual([
        { item_id: made[0]!.id, name: 'Banquet napkin', base_uom: 'each' },
        { item_id: made[1]!.id, name: 'Paneer', base_uom: 'kg' },
      ]);

      // someone at another outlet does not see the event, so gets nothing
      const other = await attemptAs(c, ids.user('test.bar-manager.3.0'), names, [id]);
      expect(other.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});
