import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Rooms (contents, breakfast) and Linen & uniforms (ADR 094) on Test Hotel 1.0: a Deluxe room
// holds two bath towels (file 44) and room 201 four; a count is kept per room and item. The
// day's breakfast is entered by front office and housekeeping and read by the kitchen and the
// restaurant too. The laundry exchange keeps what is still at the laundry; uniforms are issued
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

describe('breakfast by mode', () => {
  it('front office gives the totals and the rooms; housekeeping changes a room', async () => {
    await inRolledBackTx(async (c) => {
      const day = await today(c);
      await run(
        c,
        'test.front-desk-executive.1.0',
        `select ops.set_breakfast_total($1, $2, 'in_room', 3)`,
        [ids.node(OUTLET), day],
      );
      await run(
        c,
        'test.front-desk-executive.1.0',
        `select ops.set_breakfast_total($1, $2, 'buffet', 20)`,
        [ids.node(OUTLET), day],
      );
      await run(
        c,
        'test.front-desk-executive.1.0',
        `select ops.set_breakfast_room($1, $2, 'in_room', 2, 'no onion')`,
        [await room(c, '101'), day],
      );
      // a guest calls housekeeping at night: one more in 102
      await run(
        c,
        'test.room-attendant.1.0',
        `select ops.set_breakfast_room($1, $2, 'in_room', 1, null)`,
        [await room(c, '102'), day],
      );
      const rows = await run<{ mode: string; total: number; rooms: number }>(
        c,
        'test.executive-chef.1.0',
        `select mode, total, rooms from ops.breakfast_day($1, $2) order by mode`,
        [ids.node(OUTLET), day],
      );
      expect(rows).toEqual([
        { mode: 'buffet', total: 20, rooms: 0 },
        { mode: 'in_room', total: 3, rooms: 3 },
      ]);
    });
  });

  it('the kitchen and restaurant read it but do not change it; engineering does not see it', async () => {
    await inRolledBackTx(async (c) => {
      const day = await today(c);
      for (const who of ['test.executive-chef.1.0', 'test.steward.1.0']) {
        const r = await attemptAs(c, ids.user(who), `select * from ops.breakfast_day($1, $2)`, [
          ids.node(OUTLET),
          day,
        ]);
        expect(r.error, who).toBeUndefined();
      }
      const chef = await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        `select ops.set_breakfast_total($1, $2, 'buffet', 5)`,
        [ids.node(OUTLET), day],
      );
      expect(chef.error).toMatch(/NOT_AUTHORISED/);
      const tech = await attemptAs(
        c,
        ids.user('test.technician.1.0'),
        `select * from ops.breakfast_day($1, $2)`,
        [ids.node(OUTLET), day],
      );
      expect(tech.error).toMatch(/NOT_AUTHORISED/);
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
