import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Rooms (contents, breakfast) and Linen & uniforms (ADR 094) on Test Hotel 1.0: a Deluxe room
// holds two bath towels (file 44) and room 201 four; a count is kept per room and item. The
// day's meals are set by room by the restaurant (ADR 121) and read by the kitchen, front office
// and housekeeping. The laundry exchange keeps what is still at the laundry; uniforms are issued
// and returned.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const OUTLET = 'TEST-HOTEL-1.0';
const HK = 'TEST-HOTEL-1.0-HOUSEKEEPING';

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

const room = async (c: PoolClient, number: string) =>
  (
    await c.query<{ id: string }>(
      `select id from ops.room where org_node_id = $1 and number = $2`,
      [ids.node(OUTLET), number],
    )
  ).rows[0]!.id;

const item = async (c: PoolClient, sku: string) =>
  (
    await c.query<{ id: string }>(`select id from inv.item where tenant_id = $1 and sku = $2`, [
      ids.tenant(),
      sku,
    ])
  ).rows[0]!.id;

const today = async (c: PoolClient) =>
  (await c.query<{ d: string }>(`select rpt.today($1)::text as d`, [ids.node(OUTLET)])).rows[0]!.d;

// The breakfast still to come (ADR 110): today's until it ends, then tomorrow's.
const nextBreakfast = async (c: PoolClient) =>
  (await c.query<{ d: string }>(`select ops.breakfast_next($1)::text as d`, [ids.node(OUTLET)]))
    .rows[0]!.d;

const breakfastEnds = (c: PoolClient, at: string) =>
  c.query(
    `update core.tenant set settings = settings || jsonb_build_object('breakfast_ends', $2::text)
            where id = $1`,
    [ids.tenant(), at],
  );

describe('room contents', () => {
  it("a room holds its type's things, and its own line wins", async () => {
    await inRolledBackTx(async (c) => {
      const rows = await run<{ number: string; item: string; expected: string }>(
        c,
        'test.room-attendant.1.0',
        `select number, item, expected::text from ops.room_contents($1)
          where item = 'Test Bath Towel' order by number`,
        [ids.node(OUTLET)],
      );
      // 101-103 are Deluxe; 201 has its own line; 202, a Suite, holds nothing listed
      expect(rows).toEqual([
        { number: '101', item: 'Test Bath Towel', expected: '2.000' },
        { number: '102', item: 'Test Bath Towel', expected: '2.000' },
        { number: '103', item: 'Test Bath Towel', expected: '2.000' },
        { number: '201', item: 'Test Bath Towel', expected: '4.000' },
      ]);
    });
  });

  it('a count is kept and shown; short lines are counted; the stock does not move', async () => {
    await inRolledBackTx(async (c) => {
      const r101 = await room(c, '101');
      const towel = await item(c, 'BATH-TOWEL');
      const soap = await item(c, 'SOAP-BAR-40G');
      const ledger = await c.query<{ n: string }>(`select count(*) as n from inv.stock_ledger`);
      const [short] = await run<{ n: number }>(
        c,
        'test.room-attendant.1.0',
        `select ops.count_room($1, $2::jsonb) as n`,
        [
          r101,
          JSON.stringify([
            { item_id: towel, counted: 1 },
            { item_id: soap, counted: 2 },
          ]),
        ],
      );
      expect(short!.n).toBe(1);
      const shown = await run<{ counted: string; counted_by: string }>(
        c,
        'test.housekeeping-supervisor.1.0',
        `select counted::text, counted_by from ops.room_contents($1)
          where room_id = $2 and item = 'Test Bath Towel'`,
        [ids.node(OUTLET), r101],
      );
      expect(shown).toEqual([{ counted: '1.000', counted_by: 'Test Room Attendant 1.0' }]);
      const after = await c.query<{ n: string }>(`select count(*) as n from inv.stock_ledger`);
      expect(after.rows[0]!.n).toBe(ledger.rows[0]!.n);
    });
  });

  it('only what the room holds, and only by those who look after rooms', async () => {
    await inRolledBackTx(async (c) => {
      const r101 = await room(c, '101');
      const onions = await attemptAs(
        c,
        ids.user('test.room-attendant.1.0'),
        `select ops.count_room($1, $2::jsonb)`,
        [r101, JSON.stringify([{ item_id: await item(c, 'ONIONS'), counted: 1 }])],
      );
      expect(onions.error).toMatch(/INVALID_VALUE/);
      const commis = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        `select ops.count_room($1, $2::jsonb)`,
        [r101, JSON.stringify([{ item_id: await item(c, 'BATH-TOWEL'), counted: 2 }])],
      );
      expect(commis.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});

const mealEnds = (c: PoolClient, meal: string, at: string) =>
  c.query(
    `update core.tenant set settings = settings || jsonb_build_object($2::text, $3::text)
            where id = $1`,
    [ids.tenant(), `${meal}_ends`, at],
  );

const mealRooms = async (c: PoolClient, lines: [string, number, string?][]) =>
  JSON.stringify(
    await Promise.all(
      lines.map(async ([n, guests, note]) => ({ room_id: await room(c, n), guests, note })),
    ),
  );

describe('meals by room (ADR 121)', () => {
  it("the restaurant sets each meal by room; the guests are the rooms'; a 0 takes one off", async () => {
    await inRolledBackTx(async (c) => {
      const day = await nextBreakfast(c);
      await run(
        c,
        'test.steward.1.0',
        `select ops.set_meal_rooms($1, $2, 'breakfast', 'in_room', $3::jsonb)`,
        [
          ids.node(OUTLET),
          day,
          await mealRooms(c, [
            ['101', 2, 'no onion'],
            ['102', 1],
          ]),
        ],
      );
      await run(
        c,
        'test.captain.1.0',
        `select ops.set_meal_rooms($1, $2, 'breakfast', 'buffet', $3::jsonb)`,
        [
          ids.node(OUTLET),
          day,
          await mealRooms(c, [
            ['201', 3],
            ['202', 2],
          ]),
        ],
      );
      // a guest calls: 102 has its breakfast in the restaurant after all
      await run(
        c,
        'test.steward-b.1.0',
        `select ops.set_meal_rooms($1, $2, 'breakfast', 'buffet', $3::jsonb)`,
        [ids.node(OUTLET), day, await mealRooms(c, [['102', 1]])],
      );
      const rows = await run<{ mode: string; total: number; rooms: number; n: number }>(
        c,
        'test.executive-chef.1.0',
        `select mode, total, rooms, jsonb_array_length(room_list) as n
           from ops.breakfast_day($1, $2) order by mode`,
        [ids.node(OUTLET), day],
      );
      expect(rows).toEqual([
        { mode: 'buffet', total: 6, rooms: 6, n: 3 },
        { mode: 'in_room', total: 2, rooms: 2, n: 1 },
      ]);
      await run(
        c,
        'test.steward.1.0',
        `select ops.set_meal_rooms($1, $2, 'breakfast', 'buffet', $3::jsonb)`,
        [ids.node(OUTLET), day, await mealRooms(c, [['201', 0]])],
      );
      const after = await run<{ total: number; n: number }>(
        c,
        'test.steward.1.0',
        `select total, jsonb_array_length(room_list) as n
           from ops.meal_day($1, $2, 'breakfast') where mode = 'buffet'`,
        [ids.node(OUTLET), day],
      );
      expect(after).toEqual([{ total: 3, n: 2 }]);
    });
  });

  it('lunch and dinner are kept apart from breakfast, each with its own end', async () => {
    await inRolledBackTx(async (c) => {
      await mealEnds(c, 'lunch', '23:59:59');
      await mealEnds(c, 'dinner', '00:00');
      const next = await run<{ today: string; lunch: string; dinner: string }>(
        c,
        'test.steward.1.0',
        `select today::text, lunch_next::text as lunch, dinner_next::text as dinner
           from ops.meal_outlets() where outlet_id = $1`,
        [ids.node(OUTLET)],
      );
      const day = (
        await c.query<{ d: string }>(`select (now() at time zone ops.tz_of($1))::date::text as d`, [
          ids.node(OUTLET),
        ])
      ).rows[0]!.d;
      expect(next[0]!.lunch).toBe(day);
      expect(next[0]!.dinner > day).toBe(true);
      await run(
        c,
        'test.steward.1.0',
        `select ops.set_meal_rooms($1, $2, 'lunch', 'in_room', $3::jsonb)`,
        [ids.node(OUTLET), day, await mealRooms(c, [['101', 2]])],
      );
      const served = await attemptAs(
        c,
        ids.user('test.steward.1.0'),
        `select ops.set_meal_rooms($1, $2, 'dinner', 'in_room', $3::jsonb)`,
        [ids.node(OUTLET), day, await mealRooms(c, [['101', 2]])],
      );
      expect(served.error).toMatch(/BREAKFAST_SERVED/);
      const totals = await run<{ meal: string; total: number | null }>(
        c,
        'test.executive-chef.1.0',
        `select m.meal, d.total from (values ('breakfast'), ('lunch'), ('dinner')) m(meal)
           cross join lateral ops.meal_day($1, $2, m.meal) d where d.mode = 'in_room'
          order by m.meal`,
        [ids.node(OUTLET), day],
      );
      expect(totals).toEqual([
        { meal: 'breakfast', total: null },
        { meal: 'dinner', total: null },
        { meal: 'lunch', total: 2 },
      ]);
    });
  });

  it('the service team sets meals; the kitchen, front desk and housekeeping read; the bar and engineering do neither', async () => {
    await inRolledBackTx(async (c) => {
      const day = await nextBreakfast(c);
      const lines = await mealRooms(c, [['101', 1]]);
      for (const who of [
        'test.executive-chef.1.0',
        'test.front-desk-executive.1.0',
        'test.room-attendant.1.0',
      ]) {
        const read = await run<{ can_edit: boolean }>(
          c,
          who,
          `select can_edit from ops.meal_day($1, $2, 'breakfast')`,
          [ids.node(OUTLET), day],
        );
        expect(
          read.every((r) => !r.can_edit),
          who,
        ).toBe(true);
        const set = await attemptAs(
          c,
          ids.user(who),
          `select ops.set_meal_rooms($1, $2, 'breakfast', 'buffet', $3::jsonb)`,
          [ids.node(OUTLET), day, lines],
        );
        expect(set.error, who).toMatch(/NOT_AUTHORISED/);
      }
      // the service team picks from the rooms' numbers, without seeing the rooms (ROOMS view)
      expect(
        (await run(c, 'test.steward.1.0', `select * from ops.meal_rooms($1)`, [ids.node(OUTLET)]))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (
          await attemptAs(c, ids.user('test.steward.1.0'), `select * from ops.rooms($1)`, [
            ids.node(OUTLET),
          ])
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        (
          await attemptAs(
            c,
            ids.user('test.front-desk-executive.1.0'),
            `select * from ops.meal_rooms($1)`,
            [ids.node(OUTLET)],
          )
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
      for (const who of ['test.steward.1.0', 'test.general-manager.1.0']) {
        const r = await run<{ can_edit: boolean }>(
          c,
          who,
          `select can_edit from ops.meal_day($1, $2, 'breakfast')`,
          [ids.node(OUTLET), day],
        );
        expect(
          r.every((x) => x.can_edit),
          who,
        ).toBe(true);
      }
      for (const who of ['test.bartender.1.0', 'test.technician.1.0']) {
        const r = await attemptAs(
          c,
          ids.user(who),
          `select ops.set_meal_rooms($1, $2, 'breakfast', 'buffet', $3::jsonb)`,
          [ids.node(OUTLET), day, lines],
        );
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
      }
      const tech = await attemptAs(
        c,
        ids.user('test.technician.1.0'),
        `select * from ops.meal_day($1, $2, 'breakfast')`,
        [ids.node(OUTLET), day],
      );
      expect(tech.error).toMatch(/NOT_AUTHORISED/);
      // a room of another outlet is no room here
      const other = (
        await c.query<{ id: string }>(
          `select id from ops.room where org_node_id <> $1 and tenant_id = $2 limit 1`,
          [ids.node(OUTLET), ids.tenant()],
        )
      ).rows[0];
      if (other) {
        const r = await attemptAs(
          c,
          ids.user('test.steward.1.0'),
          `select ops.set_meal_rooms($1, $2, 'breakfast', 'buffet', $3::jsonb)`,
          [ids.node(OUTLET), day, JSON.stringify([{ room_id: other.id, guests: 1 }])],
        );
        expect(r.error).toMatch(/NOT_FOUND/);
      }
    });
  });

  it('a meal that has been served is kept as it was; up to a week ahead may be given', async () => {
    await inRolledBackTx(async (c) => {
      // before it ends (12:00 by default) today's breakfast is the next one ...
      await breakfastEnds(c, '23:59:59');
      const day = (
        await c.query<{ d: string }>(`select (now() at time zone ops.tz_of($1))::date::text as d`, [
          ids.node(OUTLET),
        ])
      ).rows[0]!.d;
      expect(await nextBreakfast(c)).toBe(day);
      const set = (d: string, extra = 0) =>
        attemptAs(
          c,
          ids.user('test.steward.1.0'),
          `select ops.set_meal_rooms($1, $2::date + $4::int, 'breakfast', 'buffet', $3::jsonb)`,
          [ids.node(OUTLET), d, JSON.stringify([]), extra],
        );
      await run(
        c,
        'test.steward.1.0',
        `select ops.set_meal_rooms($1, $2, 'breakfast', 'buffet', $3::jsonb)`,
        [ids.node(OUTLET), day, await mealRooms(c, [['101', 2]])],
      );
      // ... after it ends, tomorrow's is: today's is read, never changed
      await breakfastEnds(c, '00:00');
      const next = await nextBreakfast(c);
      expect(next > day).toBe(true);
      expect((await set(day)).error).toMatch(/BREAKFAST_SERVED/);
      const rows = await run<{ total: number; can_edit: boolean }>(
        c,
        'test.steward.1.0',
        `select total, can_edit from ops.meal_day($1, $2, 'breakfast') where mode = 'buffet'`,
        [ids.node(OUTLET), day],
      );
      expect(rows).toEqual([{ total: 2, can_edit: false }]);
      expect((await set(next, 7)).error).toBeUndefined();
      expect((await set(next, 8)).error).toMatch(/INVALID_VALUE/);
    });
  });
});

describe('rooms given to attendants (ADR 111)', () => {
  const giveRooms = `select ops.give_rooms($1, $2, $3, $4::uuid[])`;

  it('the housekeeper gives rooms; the attendant sees them as theirs and every other room too', async () => {
    await inRolledBackTx(async (c) => {
      const day = await today(c);
      const [r101, r102, r103] = [await room(c, '101'), await room(c, '102'), await room(c, '103')];
      await run(c, 'test.executive-housekeeper.1.0', giveRooms, [
        ids.node(OUTLET),
        day,
        ids.user('test.room-attendant.1.0'),
        [r101, r102],
      ]);
      // the supervisor gives 102 to the other attendant: it moves
      await run(c, 'test.housekeeping-supervisor.1.0', giveRooms, [
        ids.node(OUTLET),
        day,
        ids.user('test.room-attendant-b.1.0'),
        [r102, r103],
      ]);
      const mine = await run<{ number: string; mine: boolean; given_to_name: string | null }>(
        c,
        'test.room-attendant.1.0',
        `select number, mine, given_to_name from ops.rooms($1) where number in ('101', '102', '103', '201')
          order by number`,
        [ids.node(OUTLET)],
      );
      expect(mine.map((r) => [r.number, r.mine])).toEqual([
        ['101', true],
        ['102', false],
        ['103', false],
        ['201', false],
      ]);
      expect(mine[1]!.given_to_name).toBeTruthy();
      expect(mine[3]!.given_to_name).toBeNull();
      const bars = await run<{ number: string; mine: boolean }>(
        c,
        'test.room-attendant.1.0',
        `select number, mine from ops.minibar_rooms($1) where mine`,
        [ids.node(OUTLET)],
      );
      expect(bars.map((r) => r.number)).toEqual(['101']);
      // giving the same person fewer rooms takes the others off them
      await run(c, 'test.executive-housekeeper.1.0', giveRooms, [
        ids.node(OUTLET),
        day,
        ids.user('test.room-attendant-b.1.0'),
        [r103],
      ]);
      const b = await run<{ number: string }>(
        c,
        'test.room-attendant-b.1.0',
        `select number from ops.rooms($1) where mine order by number`,
        [ids.node(OUTLET)],
      );
      expect(b.map((r) => r.number)).toEqual(['103']);
    });
  });

  it('attendants and the front desk do not give rooms; rooms go only to housekeeping', async () => {
    await inRolledBackTx(async (c) => {
      const day = await today(c);
      const r101 = await room(c, '101');
      for (const who of [
        'test.room-attendant.1.0',
        'test.front-desk-executive.1.0',
        'test.executive-chef.1.0',
      ]) {
        const r = await attemptAs(c, ids.user(who), giveRooms, [
          ids.node(OUTLET),
          day,
          ids.user('test.room-attendant.1.0'),
          [r101],
        ]);
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
      }
      const notHk = await attemptAs(c, ids.user('test.executive-housekeeper.1.0'), giveRooms, [
        ids.node(OUTLET),
        day,
        ids.user('test.front-desk-executive.1.0'),
        [r101],
      ]);
      expect(notHk.error).toMatch(/INVALID_VALUE/);
      const yesterday = await attemptAs(c, ids.user('test.executive-housekeeper.1.0'), giveRooms, [
        ids.node(OUTLET),
        (await c.query<{ d: string }>(`select ($1::date - 1)::text as d`, [day])).rows[0]!.d,
        ids.user('test.room-attendant.1.0'),
        [r101],
      ]);
      expect(yesterday.error).toMatch(/INVALID_VALUE/);
      const people = await run<{ name: string }>(
        c,
        'test.executive-housekeeper.1.0',
        `select name from ops.room_people($1)`,
        [ids.node(OUTLET)],
      );
      expect(people.length).toBeGreaterThanOrEqual(2);
      const gives = await run<{ g: boolean }>(
        c,
        'test.room-attendant.1.0',
        `select ops.gives_rooms($1) as g`,
        [ids.node(OUTLET)],
      );
      expect(gives[0]!.g).toBe(false);
    });
  });
});

describe('linen and uniforms', () => {
  it('what is still at the laundry is the running difference', async () => {
    await inRolledBackTx(async (c) => {
      const day = await today(c);
      const towel = await item(c, 'BATH-TOWEL');
      const yesterday = (await c.query<{ d: string }>(`select ($1::date - 1)::text as d`, [day]))
        .rows[0]!.d;
      await run(c, 'test.laundry-attendant.1.0', `select ops.record_laundry($1, $2, $3::jsonb)`, [
        ids.node(HK),
        yesterday,
        JSON.stringify([{ item_id: towel, sent: 30, received: 0 }]),
      ]);
      await run(c, 'test.laundry-attendant.1.0', `select ops.record_laundry($1, $2, $3::jsonb)`, [
        ids.node(HK),
        day,
        JSON.stringify([{ item_id: towel, sent: 20, received: 28 }]),
      ]);
      const rows = await run<{ day: string; at_laundry: number }>(
        c,
        'test.executive-housekeeper.1.0',
        `select day::text, at_laundry from ops.laundry($1) where item = 'Test Bath Towel'`,
        [ids.node(HK)],
      );
      expect(rows).toEqual([
        { day, at_laundry: 22 },
        { day: yesterday, at_laundry: 30 },
      ]);
    });
  });

  it('a uniform is issued to someone at the outlet and returned once', async () => {
    await inRolledBackTx(async (c) => {
      const [u] = await run<{ id: string }>(
        c,
        'test.housekeeping-supervisor.1.0',
        `select ops.issue_uniform($1, $2, 'Housekeeping tunic', 'M', 2) as id`,
        [ids.node(HK), ids.user('test.room-attendant-b.1.0')],
      );
      const held = await run<{ person: string; returned_at: string | null }>(
        c,
        'test.executive-housekeeper.1.0',
        `select person, returned_at from ops.uniforms($1) where id = $2`,
        [ids.node(HK), u!.id],
      );
      expect(held).toEqual([{ person: 'Test Room Attendant B 1.0', returned_at: null }]);
      await run(c, 'test.housekeeping-supervisor.1.0', `select ops.return_uniform($1)`, [u!.id]);
      const again = await attemptAs(
        c,
        ids.user('test.housekeeping-supervisor.1.0'),
        `select ops.return_uniform($1)`,
        [u!.id],
      );
      expect(again.error).toMatch(/INVALID_STATE/);
      const elsewhere = await attemptAs(
        c,
        ids.user('test.housekeeping-supervisor.1.0'),
        `select ops.issue_uniform($1, $2, 'Tunic', null, 1)`,
        [ids.node(HK), ids.user('test.bar-manager.3.0')],
      );
      expect(elsewhere.error).toMatch(/INVALID_VALUE/);
    });
  });

  it('nothing while the blocks are off', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `update core.tenant set settings = jsonb_set(settings, '{modules}',
           coalesce(settings -> 'modules', '{}') || '{"linen": false, "rooms": false}')
          where id = $1`,
        [ids.tenant()],
      );
      const laundry = await attemptAs(
        c,
        ids.user('test.laundry-attendant.1.0'),
        `select * from ops.laundry($1)`,
        [ids.node(HK)],
      );
      expect(laundry.error).toMatch(/NOT_AUTHORISED/);
      const contents = await attemptAs(
        c,
        ids.user('test.room-attendant.1.0'),
        `select * from ops.room_contents($1)`,
        [ids.node(OUTLET)],
      );
      expect(contents.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});
