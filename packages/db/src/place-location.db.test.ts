import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Setting an outlet's or site's location in the app (Prompt 11a, ADR 018).
//  * Who: ATTENDANCE modify at the place itself (the GM and AGM, OUTLET_MANAGER), or
//    COMPANY_SETTINGS modify (the Account Owner). A department head's ATTENDANCE modify is
//    on their department, so it does not reach the outlet.
//  * What: the same hr.node_setting row file 04 writes, audited, and used by the next
//    clock-in. The row remembers who set it in the app, for the import's warning.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const SET = 'select hr.set_place_location($1, $2, $3, $4)';
const NEW = { lat: 19.06, lng: 72.83, radius: 200 };

async function set(
  c: PoolClient,
  user: string,
  place: string,
  v: { lat: number | null; lng: number | null; radius: number } = NEW,
) {
  return (await attemptAs(c, ids.user(user), SET, [ids.node(place), v.lat, v.lng, v.radius])).error;
}

async function row(c: PoolClient, place: string) {
  const { rows } = await c.query<{
    latitude: string;
    longitude: string;
    geofence_radius_m: number;
    set_in_app_by: string | null;
    set_in_app_at: Date | null;
  }>(
    `select latitude, longitude, geofence_radius_m, set_in_app_by, set_in_app_at
       from hr.node_setting where org_node_id = $1`,
    [ids.node(place)],
  );
  return rows[0];
}

describe('hr.set_place_location: who', () => {
  it('the GM and AGM at their own outlet', async () => {
    await inRolledBackTx(async (c) => {
      expect(await set(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0')).toBeUndefined();
      expect(await row(c, 'TEST-HOTEL-1.0')).toMatchObject({
        latitude: '19.060000',
        longitude: '72.830000',
        geofence_radius_m: 200,
        set_in_app_by: ids.user('test.general-manager.1.0'),
      });
      expect(
        await set(c, 'test.assistant-general-manager.1.0', 'TEST-HOTEL-1.0', {
          ...NEW,
          radius: 250,
        }),
      ).toBeUndefined();
      expect((await row(c, 'TEST-HOTEL-1.0'))!.set_in_app_by).toBe(
        ids.user('test.assistant-general-manager.1.0'),
      );
    });
  });

  it('the Account Owner anywhere in their company, including a site', async () => {
    await inRolledBackTx(async (c) => {
      expect(await set(c, 'test.account-owner', 'TEST-GUEST-HOUSE-2.0')).toBeUndefined();
      expect(await set(c, 'test.account-owner', 'TEST-CENTRAL-KITCHEN')).toBeUndefined();
      expect(await set(c, 'test.solo.bar-manager', 'TEST-SOLO-BAR')).toBeUndefined();
    });
  });

  it('NOT_AUTHORISED: department heads, staff, HR, the area manager, another outlet’s GM, another customer', async () => {
    await inRolledBackTx(async (c) => {
      for (const [user, place] of [
        ['test.executive-chef.1.0', 'TEST-HOTEL-1.0'],
        ['test.chief-engineer.1.0', 'TEST-HOTEL-1.0'],
        ['test.commis.1.0', 'TEST-HOTEL-1.0'],
        ['test.hr-admin', 'TEST-HOTEL-1.0'],
        ['test.area-manager', 'TEST-HOTEL-1.0'],
        ['test.general-manager.2.0', 'TEST-HOTEL-1.0'],
        ['test.general-manager.1.0', 'TEST-HOTEL-1.1'],
        ['test.solo.bar-manager', 'TEST-HOTEL-1.0'],
        ['test.account-owner', 'TEST-SOLO-BAR'],
      ] as const) {
        expect(await set(c, user, place), `${user} at ${place}`).toBe('NOT_AUTHORISED');
      }
      expect((await row(c, 'TEST-HOTEL-1.0'))!.set_in_app_by).toBeNull();
    });
  });

  it('only outlets and sites: a department or a stock place is INVALID_PLACE', async () => {
    await inRolledBackTx(async (c) => {
      expect(await set(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0-KITCHEN')).toBe(
        'INVALID_PLACE',
      );
      expect(await set(c, 'test.account-owner', 'TEST-HOTEL-1.0-BAR-STORE')).toBe('INVALID_PLACE');
    });
  });

  it('bad values: INVALID_LOCATION and INVALID_RADIUS (10 to 5000 m)', async () => {
    await inRolledBackTx(async (c) => {
      const gm = 'test.general-manager.1.0';
      expect(await set(c, gm, 'TEST-HOTEL-1.0', { ...NEW, lat: 91 })).toBe('INVALID_LOCATION');
      expect(await set(c, gm, 'TEST-HOTEL-1.0', { ...NEW, lng: -181 })).toBe('INVALID_LOCATION');
      expect(await set(c, gm, 'TEST-HOTEL-1.0', { ...NEW, lat: null })).toBe('INVALID_LOCATION');
      expect(await set(c, gm, 'TEST-HOTEL-1.0', { ...NEW, radius: 9 })).toBe('INVALID_RADIUS');
      expect(await set(c, gm, 'TEST-HOTEL-1.0', { ...NEW, radius: 5001 })).toBe('INVALID_RADIUS');
    });
  });

  it('app_rw cannot write the row directly', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        `update hr.node_setting set geofence_radius_m = 999 where org_node_id = $1`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      expect(r.error).toMatch(/permission denied/);
    });
  });
});

describe('hr.location_places: what the screen offers', () => {
  it('the places each person can set, with the current values', async () => {
    await inRolledBackTx(async (c) => {
      const places = async (user: string) =>
        (
          await attemptAs<{ code: string; geofence_radius_m: number }>(
            c,
            ids.user(user),
            'select code, geofence_radius_m from hr.location_places() order by code',
          )
        ).rows!;
      expect(await places('test.general-manager.1.0')).toEqual([
        { code: 'TEST-HOTEL-1.0', geofence_radius_m: 150 },
      ]);
      expect((await places('test.account-owner')).map((p) => p.code)).toEqual([
        'TEST-BAR-3.0',
        'TEST-CENTRAL-KITCHEN',
        'TEST-GUEST-HOUSE-2.0',
        'TEST-HOTEL-1.0',
        'TEST-HOTEL-1.1',
      ]);
      expect(await places('test.executive-chef.1.0')).toEqual([]);
      expect(await places('test.commis.1.0')).toEqual([]);
    });
  });
});

describe('effective immediately, and audited', () => {
  it('the next clock-in uses the new fence; the change is in the audit log', async () => {
    await inRolledBackTx(async (c) => {
      const commis = ids.user('test.commis-b.1.0');
      await c.query(
        `update hr.attendance set clock_out_at = clock_in_at, out_source = 'online'
          where owner_user_id = $1 and clock_out_at is null`,
        [commis],
      );
      // 2 km north of the file's location: outside its fence
      const there = { lat: 19.0776, lng: 72.8295 };
      expect(
        await set(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0', { ...there, radius: 100 }),
      ).toBeUndefined();
      const r = await attemptAs<{ inside: boolean; flags: string[] }>(
        c,
        commis,
        `select inside, flags from hr.clock('in', $1, $2, 10, null, 'online', 'loc-test')`,
        [there.lat, there.lng],
      );
      expect(r.rows).toEqual([{ inside: true, flags: ['no_selfie'] }]);
      const audit = await c.query<{ actor_id: string; changed: string[] }>(
        `select actor_id, changed_fields as changed from audit.log
          where table_name = 'hr.node_setting' and (after ->> 'org_node_id')::uuid = $1
          order by occurred_at desc limit 1`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      expect(audit.rows[0]!.actor_id).toBe(ids.user('test.general-manager.1.0'));
      expect(audit.rows[0]!.changed).toEqual(
        expect.arrayContaining(['latitude', 'geofence_radius_m', 'set_in_app_by']),
      );
    });
  });
});
