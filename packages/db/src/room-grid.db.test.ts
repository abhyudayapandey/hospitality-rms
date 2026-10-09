import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  type SeedIds,
} from '../test/helpers';

// Checklists, part 2 (ADR 088): what was done about a reading out of range, the food probed,
// a round for each room or area, and each room's status (the Rooms block).

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const OUTLET = 'TEST-HOTEL-1.0';

async function run<T extends object = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  sql: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, ids.user(who), sql, params);
  if (r.error) throw new Error(`${who}: ${r.error}`);
  return r.rows!;
}

async function tick(c: PoolClient, now: string) {
  await actAs(c, 'wf_executor', null);
  await c.query('select * from ops.tasks_tick($1::timestamptz)', [now]);
  await resetRole(c);
}

/** Test Company's round of a file 29 checklist due on 5 Oct 2026. */
async function round(c: PoolClient, code: string) {
  await tick(c, '2026-10-05T06:00:00+05:30');
  const { rows } = await c.query<{ id: string }>(
    `select t.id from ops.task t join ops.checklist_template c on c.id = t.template_id
      where c.code = $1 and t.due_at::date = '2026-10-05' order by t.due_at limit 1`,
    [code],
  );
  return rows[0]!.id;
}

const steps = async (c: PoolClient, task: string) =>
  (
    await c.query<{ id: string; row: string; label: string; room: string | null }>(
      `select s.id, s.grid_row as row, s.label, r.number as room
         from ops.task_step s left join ops.room r on r.id = s.room_id
        where s.task_id = $1 order by s.position`,
      [task],
    )
  ).rows;

const switchFor = (c: PoolClient, code: string, on: boolean) =>
  c.query(
    `update core.tenant set settings = jsonb_set(settings, '{modules}',
       coalesce(settings -> 'modules', '{}') || jsonb_build_object($2::text, $3::boolean))
      where id = $1`,
    [ids.tenant(), code, on],
  );

describe('a round for each room or area', () => {
  it("each room of the outlet, in order, the checklist's steps for each", async () => {
    await inRolledBackTx(async (c) => {
      const s = await steps(c, await round(c, 'HOTEL-1.0-HK-ROOM-CHECK'));
      const rooms = (
        await c.query<{ number: string }>(
          `select r.number from ops.room r where r.org_node_id = $1 and r.archived_at is null
            order by r.floor nulls first, r.number`,
          [ids.node(OUTLET)],
        )
      ).rows.map((r) => r.number);
      expect(rooms.length).toBeGreaterThan(1);
      expect(s).toHaveLength(rooms.length * 3);
      expect(s.slice(0, 3).map((x) => [x.row, x.label, x.room])).toEqual([
        [rooms[0], 'Bed made', rooms[0]],
        [rooms[0], 'Bath towels', rooms[0]],
        [rooms[0], 'Toiletries topped up', rooms[0]],
      ]);
      expect([...new Set(s.map((x) => x.row))]).toEqual(rooms);
    });
  });

  it('each named area, as file 29 lists them', async () => {
    await inRolledBackTx(async (c) => {
      const s = await steps(c, await round(c, 'HOTEL-1.0-HK-PUBLIC-AREAS'));
      expect(s.map((x) => `${x.row}: ${x.label}`)).toEqual([
        'Lobby: Floor mopped',
        'Lobby: Bins emptied',
        'Corridor 1: Floor mopped',
        'Corridor 1: Bins emptied',
        'Corridor 2: Floor mopped',
        'Corridor 2: Bins emptied',
      ]);
      expect(s.every((x) => x.room === null)).toBe(true);
    });
  });

  it('refuses what it cannot read', async () => {
    await inRolledBackTx(async (c) => {
      for (const bad of [
        { rooms: false },
        { areas: [] },
        { areas: ['Lobby', 'lobby'] },
        { areas: ['Lobby'], rooms: true },
      ]) {
        await c.query('savepoint s');
        await expect(
          c.query(`select ops.check_for_each($1::jsonb)`, [JSON.stringify(bad)]),
          JSON.stringify(bad),
        ).rejects.toThrow(/INVALID_FOR_EACH/);
        await c.query('rollback to savepoint s');
      }
    });
  });
});

describe('readings', () => {
  it('out of range needs what was done about it; the lead is told both', async () => {
    await inRolledBackTx(async (c) => {
      const task = await round(c, 'HOTEL-1.0-KITCHEN-PROBE');
      const [s] = await steps(c, task);
      const step = (v: object) =>
        attemptAs(c, ids.user('test.commis.1.0'), `select ops.complete_step($1, $2, $3::jsonb)`, [
          task,
          s!.id,
          JSON.stringify(v),
        ]);
      // the probe asks which food, and whether out-of-date food was thrown away
      expect((await step({ number: 70, thrown: false })).error).toMatch(/INVALID_VALUE/);
      expect((await step({ number: 70, food: 'Dal makhani' })).error).toMatch(/INVALID_VALUE/);
      expect((await step({ number: 50, food: 'Dal makhani', thrown: false })).error).toMatch(
        /ACTION_NEEDED/,
      );
      expect(
        (await step({ number: 50, food: 'Dal makhani', thrown: true, action: 'Reheated to 75' }))
          .error,
      ).toBeUndefined();
      const done = await c.query(
        `select action_text, food_text, thrown_away, flagged from ops.task_step where id = $1`,
        [s!.id],
      );
      expect(done.rows[0]).toEqual({
        action_text: 'Reheated to 75',
        food_text: 'Dal makhani',
        thrown_away: true,
        flagged: true,
      });
      const told = await c.query<{ body: string }>(
        `select body from ops.notification where owner_user_id = $1 and kind = 'task_flagged'
          order by created_at desc limit 1`,
        [ids.user('test.executive-chef.1.0')],
      );
      expect(told.rows[0]!.body).toBe('Acceptable: 63 to 100. Done: Reheated to 75');
    });
  });
});

describe('room status (the Rooms block)', () => {
  const outletRooms = async (c: PoolClient, who: string) =>
    run<{ room_id: string; number: string; status: string; can_set: boolean }>(
      c,
      who,
      `select room_id, number, status, can_set from ops.rooms($1)`,
      [ids.node(OUTLET)],
    );

  it('housekeeping and front office set it; it starts vacant clean', async () => {
    await inRolledBackTx(async (c) => {
      const rooms = await outletRooms(c, 'test.room-attendant.1.0');
      expect(rooms.every((r) => r.status === 'VC' && r.can_set)).toBe(true);
      await run(c, 'test.room-attendant.1.0', `select ops.set_room_status($1, 'VD')`, [
        rooms[0]!.room_id,
      ]);
      await run(c, 'test.front-desk-executive.1.0', `select ops.set_room_status($1, 'ARR')`, [
        rooms[1]!.room_id,
      ]);
      const after = await outletRooms(c, 'test.general-manager.1.0');
      expect(after.slice(0, 2).map((r) => r.status)).toEqual(['VD', 'ARR']);
      const bad = await attemptAs(
        c,
        ids.user('test.room-attendant.1.0'),
        `select ops.set_room_status($1, 'DIRTY')`,
        [rooms[0]!.room_id],
      );
      expect(bad.error).toMatch(/INVALID_VALUE/);
    });
  });

  it('nobody else: not the kitchen, not another customer; nothing while Rooms is off', async () => {
    await inRolledBackTx(async (c) => {
      const [room] = await outletRooms(c, 'test.general-manager.1.0');
      const commis = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        `select ops.set_room_status($1, 'VD')`,
        [room!.room_id],
      );
      expect(commis.error).toMatch(/NOT_AUTHORISED/);
      const reads = await attemptAs(c, ids.user('test.commis.1.0'), `select * from ops.rooms($1)`, [
        ids.node(OUTLET),
      ]);
      expect(reads.error).toMatch(/NOT_AUTHORISED/);
      const solo = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        `select ops.set_room_status($1, 'VD')`,
        [room!.room_id],
      );
      expect(solo.error).toMatch(/NOT_FOUND/);
      // the table is written only through the functions
      const direct = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        `insert into ops.room_status (tenant_id, org_node_id, room_id, status)
         values ($1, $2, $3, 'VD')`,
        [ids.tenant(), ids.node(OUTLET), room!.room_id],
      );
      expect(direct.error).toMatch(/permission denied/);

      await switchFor(c, 'rooms', false);
      const off = await attemptAs(
        c,
        ids.user('test.room-attendant.1.0'),
        `select ops.set_room_status($1, 'VD')`,
        [room!.room_id],
      );
      expect(off.error).toMatch(/NOT_AUTHORISED/);
      const places = await run(c, 'test.room-attendant.1.0', `select * from ops.room_outlets()`);
      expect(places).toEqual([]);
    });
  });

  it("the grid shows each room's status, and who may set it from there", async () => {
    await inRolledBackTx(async (c) => {
      const task = await round(c, 'HOTEL-1.0-HK-ROOM-CHECK');
      const [first] = await steps(c, task);
      const rooms = await outletRooms(c, 'test.general-manager.1.0');
      await run(c, 'test.room-attendant.1.0', `select ops.set_room_status($1, 'OCC')`, [
        rooms.find((r) => r.number === first!.room)!.room_id,
      ]);
      const [d] = await run<{
        t: { can_set_room_status: boolean; steps: { room_status: string }[] };
      }>(c, 'test.room-attendant.1.0', `select ops.task_detail($1) as t`, [task]);
      expect(d!.t.can_set_room_status).toBe(true);
      expect(d!.t.steps[0]!.room_status).toBe('OCC');
    });
  });
});
