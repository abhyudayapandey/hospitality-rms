import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// A room's status carries its details (ADR 117) on Test Hotel 1.0: arriving and leaving
// rooms their time; an out-of-order room its reason, the day it is back and its maintenance
// request, an open one at the outlet or one raised from the room. House use is gone.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const OUTLET = 'TEST-HOTEL-1.0';
const DESK = 'test.front-desk-executive.1.0';

const room = async (c: PoolClient, number: string) =>
  (
    await c.query<{ id: string }>(
      `select id from ops.room where org_node_id = $1 and number = $2`,
      [ids.node(OUTLET), number],
    )
  ).rows[0]!.id;

const set = (c: PoolClient, who: string, r: string, status: string, d: object = {}) =>
  attemptAs(c, ids.user(who), `select ops.set_room_status($1, $2, $3::jsonb)`, [
    r,
    status,
    JSON.stringify(d),
  ]);

type Row = {
  number: string;
  status: string;
  status_name: string;
  at_time: string | null;
  reason: string | null;
  until: string | null;
  maintenance_title: string | null;
};
const read = async (c: PoolClient, number: string) => {
  const r = await attemptAs<Row>(
    c,
    ids.user(DESK),
    `select number, status, status_name, at_time, reason, until::text as until, maintenance_title
       from ops.rooms($1)`,
    [ids.node(OUTLET)],
  );
  return r.rows!.find((x) => x.number === number)!;
};

describe('a room status with its details (ADR 117)', () => {
  it('keeps the time of an arriving or leaving room, and drops it with the status', async () => {
    await inRolledBackTx(async (c) => {
      const r = await room(c, '101');
      expect((await set(c, DESK, r, 'ARR', { time: '14:30' })).error).toBeUndefined();
      expect(await read(c, '101')).toMatchObject({
        status: 'ARR',
        status_name: 'Arriving',
        at_time: '14:30',
      });
      expect((await set(c, DESK, r, 'DEP', { time: '11:00' })).error).toBeUndefined();
      expect(await read(c, '101')).toMatchObject({ status_name: 'Leaving', at_time: '11:00' });
      expect((await set(c, DESK, r, 'VD')).error).toBeUndefined();
      expect(await read(c, '101')).toMatchObject({ status: 'VD', at_time: null });
    });
  });

  it('needs a reason for out of order; keeps the day it is back and raises a request', async () => {
    await inRolledBackTx(async (c) => {
      const r = await room(c, '101');
      expect((await set(c, DESK, r, 'OOO')).error).toMatch(/REASON_REQUIRED/);
      expect((await set(c, DESK, r, 'OOO', { reason: 'x', until: '2001-01-01' })).error).toMatch(
        /INVALID_VALUE/,
      );
      const until = (
        await c.query<{ d: string }>(`select (rpt.today($1) + 3)::text d`, [ids.node(OUTLET)])
      ).rows[0]!.d;
      const done = await set(c, DESK, r, 'OOO', { reason: 'AC not cooling', until, raise: true });
      expect(done.error).toBeUndefined();
      expect(await read(c, '101')).toMatchObject({
        status: 'OOO',
        reason: 'AC not cooling',
        until,
        maintenance_title: 'Room 101: AC not cooling',
      });
      // the request is maintenance's, open at the outlet, and offered for the next room
      const open = await attemptAs<{ title: string }>(
        c,
        ids.user(DESK),
        `select title from ops.room_maintenance_open($1)`,
        [await room(c, '102')],
      );
      expect(open.rows!.map((x) => x.title)).toContain('Room 101: AC not cooling');
    });
  });

  it('tags an open request at the outlet, never one elsewhere', async () => {
    await inRolledBackTx(async (c) => {
      const elsewhere = (
        await c.query<{ id: string }>(
          `insert into ops.maintenance_request (tenant_id, org_node_id, place_node_id, title,
                                                reported_by)
           select $1, $2, $2, 'Bar fridge', $3 returning id`,
          [ids.tenant(), ids.node('TEST-BAR-3.0'), ids.user(DESK)],
        )
      ).rows[0]!.id;
      const r = await room(c, '101');
      expect(
        (await set(c, DESK, r, 'OOO', { reason: 'Leak', maintenance: elsewhere })).error,
      ).toMatch(/NOT_FOUND/);
    });
  });

  it('has no house use; no one may set it', async () => {
    await inRolledBackTx(async (c) => {
      const r = await room(c, '101');
      expect((await set(c, DESK, r, 'HM')).error).toMatch(/INVALID_VALUE/);
      expect(
        (await c.query<{ gone: boolean }>(`select ops.room_status_name('HM') is null as gone`))
          .rows[0]!.gone,
      ).toBe(true);
    });
  });

  it('only whoever keeps the rooms sets it or reads the open requests', async () => {
    await inRolledBackTx(async (c) => {
      const r = await room(c, '101');
      const cook = 'test.commis.1.0';
      expect((await set(c, cook, r, 'ARR', { time: '10:00' })).error).toMatch(/NOT_AUTHORISED/);
      expect(
        (await attemptAs(c, ids.user(cook), `select * from ops.room_maintenance_open($1)`, [r]))
          .error,
      ).toMatch(/NOT_AUTHORISED/);
    });
  });
});
