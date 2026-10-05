import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Maintenance groups repairs by where the problem is (ADR 048): ops.maintenance_requests
// returns place_node_id beside org_node_id, the node that handles it (Engineering). Home's
// "open repairs" line counts the repairs nobody has taken yet, the same ones the screen's
// "To assign" tab lists and ops.my_to_assign() offers.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

describe('maintenance requests by place', () => {
  it('each request says where the problem is, apart from who handles it', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{
        title: string;
        place_node_id: string;
        org_node_id: string;
        status: string;
      }>(
        c,
        ids.user('test.general-manager.1.0'),
        `select title, place_node_id::text, org_node_id::text, status from ops.maintenance_requests()`,
        [],
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.length).toBeGreaterThan(0);
      for (const x of r.rows!) expect(x.place_node_id).toBeTruthy();
      const dish = r.rows!.find((x) => x.title.includes('Dishwasher'));
      expect(dish, 'the test data’s dishwasher request').toBeDefined();
      expect(dish!.place_node_id).toBe(ids.node('TEST-HOTEL-1.0-KITCHEN'));
      expect(dish!.org_node_id).not.toBe(dish!.place_node_id);
    });
  });

  it('the repairs to assign are the open ones: what "To assign" lists and my_to_assign offers', async () => {
    await inRolledBackTx(async (c) => {
      const who = ids.user('test.chief-engineer.1.0');
      const open = await attemptAs<{ id: string }>(
        c,
        who,
        `select id::text from ops.maintenance_requests() where status = 'open'`,
        [],
      );
      const offered = await attemptAs<{ id: string }>(
        c,
        who,
        `select id::text from ops.my_to_assign() where kind = 'maintenance'`,
        [],
      );
      expect(open.error).toBeUndefined();
      expect(offered.error).toBeUndefined();
      const have = new Set(open.rows!.map((x) => x.id));
      for (const x of offered.rows!) expect(have.has(x.id)).toBe(true);
      expect(offered.rows!.length).toBeGreaterThan(0);
    });
  });
});
