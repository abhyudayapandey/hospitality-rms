import { MAINTENANCE_WHERE, MAINTENANCE_WHERE_CODES } from '@outlet-ops/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  type SeedIds,
} from '@outlet-ops/db/test-helpers';

// Where a problem is (ADR 125): a location at the outlet, from the product list; a
// department's location only where the outlet has that department, a room where it has rooms.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

describe('maintenance locations', () => {
  it('the database knows the same locations as the product, in the same order', async () => {
    await inRolledBackTx(async (c) => {
      const r = await c.query<{ codes: string[] }>('select ops.maintenance_where_codes() as codes');
      expect(r.rows[0]!.codes).toEqual([...MAINTENANCE_WHERE_CODES]);
    });
  });

  it("a hotel offers its rooms, pool and departments' places; a bar offers none of those", async () => {
    await inRolledBackTx(async (c) => {
      const at = async (who: string, place: string) => {
        const r = await attemptAs<{ w: string }>(
          c,
          ids.user(who),
          'select w from ops.maintenance_wheres($1) w',
          [ids.node(place)],
        );
        if (r.error !== undefined) throw new Error(r.error);
        return r.rows.map((x) => x.w);
      };
      const hotel = await at('test.room-attendant.1.0', 'TEST-HOTEL-1.0-HOUSEKEEPING');
      expect(hotel).toEqual(expect.arrayContaining(['room', 'pool', 'kitchen', 'bar', 'parking']));
      expect(hotel).toEqual(expect.arrayContaining(['terrace', 'garden']));
      const bar = await at('test.bartender.3.0', 'TEST-BAR-3.0-BAR');
      expect(bar).toContain('bar');
      expect(bar).not.toContain('room');
      expect(bar).not.toContain('pool');
      // only the places the outlet has (ADR 160): no parking, terrace or garden at a bar
      expect(bar).not.toContain('parking');
      expect(bar).not.toContain('terrace');
      expect(bar).not.toContain('garden');
      // a bar with a floor section called Terrace has a terrace
      await c.query(
        `insert into ops.service_section (tenant_id, org_node_id, name, position, created_by, updated_by)
         select n.tenant_id, n.id, 'Terrace', 9, $2, $2 from core.hierarchy_node n where n.id = $1`,
        [ids.node('TEST-BAR-3.0-BAR'), ids.user('test.bartender.3.0')],
      );
      const withTerrace = await at('test.bartender.3.0', 'TEST-BAR-3.0-BAR');
      expect(withTerrace).toContain('terrace');
      expect(withTerrace).not.toContain('garden');
      // the order is the product's
      const order = MAINTENANCE_WHERE.map((w) => w.code);
      expect([...hotel].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(hotel);
    });
  });

  it('a request keeps where it is; a location the outlet lacks is refused', async () => {
    await inRolledBackTx(async (c) => {
      const who = ids.user('test.bartender.3.0');
      const place = ids.node('TEST-BAR-3.0-BAR');
      const ok = await attemptAs<{ id: string }>(
        c,
        who,
        `select ops.raise_maintenance($1, 'Light out', null, null, null, 'outside') as id`,
        [place],
      );
      expect(ok.error).toBeUndefined();
      const row = await attemptAs<{ location: string }>(
        c,
        who,
        'select location from ops.maintenance_requests($1)',
        [ok.rows![0]!.id],
      );
      expect(row.rows![0]!.location).toBe('outside');
      const no = await attemptAs(
        c,
        who,
        `select ops.raise_maintenance($1, 'Leak', null, null, null, 'room')`,
        [place],
      );
      expect(no.error).toMatch(/INVALID_VALUE/);
    });
  });
});
