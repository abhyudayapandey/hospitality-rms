import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { newWorker, tenantOf } from '../test/workforce';

// No assumed levels (ADR 009): geofences, wastage thresholds and transfer sources are found
// by walking up from where the person or the stock is. Checked on the test customers'
// shapes: departments under outlets, stores under supply points, a supply point that holds
// stock itself (Guest House 2.0).

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

describe('walking up the tree', () => {
  it("checks a department worker against the outlet's geofence", async () => {
    await inRolledBackTx(async (c) => {
      // file 04: Test Bar 3.0 has a 150 m fence at 19.066, 72.8367; its departments none
      const w = await newWorker(c, ids, 'Walk Server', 'TEST-BAR-3.0-FLOOR-SERVICE', 'SERVER');
      const clock = (lat: number, lng: number, key: string) =>
        attemptAs<{ inside: boolean; flags: string[] }>(
          c,
          w.userId,
          `select inside, flags from hr.clock($1, $2, $3, 10, null, 'online', $4)`,
          [key.startsWith('in') ? 'in' : 'out', lat, lng, key],
        );
      const far = await clock(19.1, 72.8367, 'in-1');
      expect(far.error).toBeUndefined();
      expect(far.rows![0]).toEqual({ inside: false, flags: ['outside_geofence'] });
      const near = await clock(19.066, 72.8367, 'out-1');
      expect(near.rows![0]).toMatchObject({ inside: true });
    });
  });

  it("uses the supply point's wastage threshold for its stores unless a store sets its own", async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, ids);
      const set = (code: string, v: number) =>
        c.query(
          `insert into inv.node_setting (tenant_id, delivery_node_id, wastage_approval_value)
           values ($1, $2, $3)
           on conflict (tenant_id, delivery_node_id) do update set wastage_approval_value = $3`,
          [tenant, ids.node(code), v],
        );
      await set('TEST-HOTEL-1.0-SUPPLY', 750);
      await set('TEST-HOTEL-1.0-BAR-STORE', 300);
      const threshold = async (code: string) =>
        (
          await attemptAs<{ v: string | null }>(
            c,
            ids.user('test.general-manager.1.0'),
            'select inv.wastage_threshold($1) as v',
            [ids.node(code)],
          )
        ).rows![0]!.v;
      expect(await threshold('TEST-HOTEL-1.0-KITCHEN-STORE')).toBe('750.00');
      expect(await threshold('TEST-HOTEL-1.0-BAR-STORE')).toBe('300.00');
      // another customer's place gives nothing
      expect(await threshold('TEST-SOLO-BAR-BAR-STORE')).toBeNull();
    });
  });

  it('offers the other stores of the same location first, then hubs; only stock places', async () => {
    await inRolledBackTx(async (c) => {
      const sources = async (who: string, to: string) => {
        const r = await attemptAs<{ id: string; kind: string }>(
          c,
          ids.user(who),
          'select id, kind from inv.transfer_sources($1)',
          [ids.node(to)],
        );
        expect(r.error).toBeUndefined();
        const codes = await c.query<{ id: string; code: string }>(
          `select id, code from core.hierarchy_node where id = any ($1)`,
          [r.rows!.map((x) => x.id)],
        );
        const byId = new Map(codes.rows.map((x) => [x.id, x.code]));
        return r.rows!.map((x) => byId.get(x.id)!);
      };
      // the Executive Chef keeps Hotel 1.0's Kitchen Store
      const kitchen = await sources('test.executive-chef.1.0', 'TEST-HOTEL-1.0-KITCHEN-STORE');
      expect(kitchen.slice(0, 4)).toEqual([
        'TEST-HOTEL-1.0-BAR-STORE',
        'TEST-HOTEL-1.0-HOUSEKEEPING-STORE',
        'TEST-HOTEL-1.0-MAIN-STORE',
        'TEST-CENTRAL-KITCHEN-STORE',
      ]);
      expect(kitchen).not.toContain('TEST-HOTEL-1.0-KITCHEN-STORE');
      expect(kitchen).not.toContain('TEST-HOTEL-1.0-SUPPLY'); // holds no stock
      // the Guest House holds stock at its supply point: the hub first, not a sibling outlet
      const gh = await sources('test.general-manager.2.0', 'TEST-GUEST-HOUSE-2.0-SUPPLY');
      expect(gh[0]).toBe('TEST-CENTRAL-KITCHEN-STORE');
    });
  });
});
