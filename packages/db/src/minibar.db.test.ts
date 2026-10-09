import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The rooms' minibars (ADR 072). Test Hotel & Bar 1.0 has rooms 101 to 202 (files 40, 41):
// a "Standard" minibar of beer, cola and tonic at par 2, refilled from the Bar Store; 202 has
// none. Housekeeping and front office (the duty CHECKS_MINIBARS) and the outlet's managers
// check rooms; front office marks charges added to the bill; area managers see; nobody else.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const HOTEL = 'TEST-HOTEL-1.0';
const BAR_STORE = 'TEST-HOTEL-1.0-BAR-STORE';
const ATTENDANT = 'test.room-attendant.1.0';
const FRONT_DESK = 'test.front-desk-executive.1.0';

async function ok<T extends object>(
  c: PoolClient,
  user: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T>(c, ids.user(user), sql, params);
  if (r.error !== undefined) throw new Error(`${user}: ${r.error}`);
  return r.rows;
}

async function error(c: PoolClient, user: string, sql: string, params: unknown[] = []) {
  return (await attemptAs(c, ids.user(user), sql, params)).error;
}

async function room(c: PoolClient, number: string): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `select id from ops.room where org_node_id = $1 and number = $2`,
      [ids.node(HOTEL), number],
    )
  ).rows[0]!.id;
}

async function item(c: PoolClient, sku: string): Promise<string> {
  return (
    await c.query<{ id: string }>(`select id from inv.item where tenant_id = $1 and sku = $2`, [
      ids.tenant(),
      sku,
    ])
  ).rows[0]!.id;
}

async function onHand(c: PoolClient, sku: string): Promise<number> {
  return Number(
    (
      await c.query<{ q: string }>(`select inv.on_hand($1, $2) as q`, [
        await item(c, sku),
        ids.node(BAR_STORE),
      ])
    ).rows[0]!.q,
  );
}

/** Left in the room: beer, cola, tonic. */
async function lines(c: PoolClient, beer: number, cola: number, tonic: number) {
  return JSON.stringify([
    { item_id: await item(c, 'LAGER-BEER-330ML'), left: beer },
    { item_id: await item(c, 'COLA-300ML'), left: cola },
    { item_id: await item(c, 'TONIC-WATER-300ML'), left: tonic },
  ]);
}

describe('who sees and checks minibars', () => {
  it('housekeeping, front office and the GM at the hotel; the area manager sees only', async () => {
    await inRolledBackTx(async (c) => {
      for (const u of [
        ATTENDANT,
        FRONT_DESK,
        'test.executive-housekeeper.1.0',
        'test.general-manager.1.0',
      ]) {
        const places = await ok<{ outlet: string; rooms: number; can_check: boolean }>(
          c,
          u,
          'select * from ops.minibar_places()',
        );
        expect(places, u).toEqual([
          { outlet_id: ids.node(HOTEL), outlet: 'Test Hotel & Bar 1.0', rooms: 5, can_check: true },
        ]);
      }
      const area = await ok<{ can_check: boolean }>(
        c,
        'test.area-manager',
        'select * from ops.minibar_places()',
      );
      expect(area.map((p) => p.can_check)).toEqual([false]);
      const r101 = await room(c, '101');
      expect(
        await error(c, 'test.area-manager', 'select ops.check_minibar($1, $2)', [
          r101,
          await lines(c, 2, 2, 2),
        ]),
      ).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('refuses the kitchen, another hotel and the other company; no direct table access', async () => {
    await inRolledBackTx(async (c) => {
      const r101 = await room(c, '101');
      for (const u of ['test.commis.1.0', 'test.room-attendant.1.1', 'test.solo.bar-manager']) {
        expect(await ok(c, u, 'select * from ops.minibar_places()'), u).toEqual([]);
        expect(
          await error(c, u, 'select * from ops.minibar_rooms($1)', [ids.node(HOTEL)]),
          u,
        ).toMatch(/NOT_AUTHORISED/);
        expect(await error(c, u, 'select * from ops.minibar_room($1)', [r101]), u).toMatch(
          /NOT_AUTHORISED/,
        );
        expect(
          await error(c, u, 'select ops.check_minibar($1, $2)', [r101, await lines(c, 2, 2, 2)]),
          u,
        ).toMatch(/NOT_AUTHORISED/);
      }
      for (const t of ['ops.room', 'ops.minibar_check', 'ops.minibar_set_line']) {
        // RLS: someone without MINIBAR reads nothing; even a keeper writes only through ops.*
        const r = await attemptAs(c, ids.user('test.commis.1.0'), `select 1 from ${t}`);
        if (r.error === undefined) expect(r.rows, t).toEqual([]);
        else expect(r.error).toMatch(/permission denied/);
        expect(await error(c, ATTENDANT, `update ${t} set updated_at = now()`), t).toMatch(
          /permission denied/,
        );
      }
    });
  });
});

describe('checking a room', () => {
  it('charges what was used; the stock leaves the store when the refill is done (ADR 081)', async () => {
    await inRolledBackTx(async (c) => {
      const r101 = await room(c, '101');
      const beer = await onHand(c, 'LAGER-BEER-330ML');
      const tonic = await onHand(c, 'TONIC-WATER-300ML');
      const id = (
        await ok<{ id: string }>(c, ATTENDANT, `select ops.check_minibar($1, $2, 'k-101') as id`, [
          r101,
          await lines(c, 1, 2, 0),
        ])
      )[0]!.id;
      const [check] = (
        await c.query<{ charge: string; short: boolean; charged_at: Date | null }>(
          `select charge, short, charged_at from ops.minibar_check where id = $1`,
          [id],
        )
      ).rows;
      // one beer at 250 and two tonics at 120
      expect(check).toEqual({ charge: '490.00', short: false, charged_at: null });
      // nothing has left the store yet: the attendant refills it from their refill task
      expect(await onHand(c, 'LAGER-BEER-330ML')).toBe(beer);
      const refill = await c.query<{ id: string }>(
        `select id from ops.task where minibar_check_id = $1 and kind = 'minibar_refill'`,
        [id],
      );
      await ok(c, ATTENDANT, 'select ops.refill_minibar($1)', [refill.rows[0]!.id]);
      expect(await onHand(c, 'LAGER-BEER-330ML')).toBe(beer - 1);
      expect(await onHand(c, 'TONIC-WATER-300ML')).toBe(tonic - 2);
      const ledger = await c.query<{ n: number }>(
        `select count(*)::int n from inv.stock_ledger
          where ref_type = 'minibar' and ref_id = $1 and movement_type = 'consumption'`,
        [id],
      );
      expect(ledger.rows[0]!.n).toBe(2);
      // the same key again: the same check, nothing posted twice
      const [again] = await ok<{ id: string }>(
        c,
        ATTENDANT,
        `select ops.check_minibar($1, $2, 'k-101') as id`,
        [r101, await lines(c, 1, 2, 0)],
      );
      expect(again!.id).toBe(id);
      expect(await onHand(c, 'LAGER-BEER-330ML')).toBe(beer - 1);
      // the room list shows it checked today, with 490 to charge
      const rooms = await ok<{ number: string; checked_today: boolean; to_charge: string }>(
        c,
        FRONT_DESK,
        'select * from ops.minibar_rooms($1)',
        [ids.node(HOTEL)],
      );
      expect(rooms.find((r) => r.number === '101')).toMatchObject({
        checked_today: true,
        to_charge: '490.00',
      });
      expect(rooms.find((r) => r.number === '102')).toMatchObject({ checked_today: false });
    });
  });

  it('counts every item of the set once, never less than nothing; a room with no minibar', async () => {
    await inRolledBackTx(async (c) => {
      const r101 = await room(c, '101');
      const two = JSON.stringify((JSON.parse(await lines(c, 2, 2, 2)) as unknown[]).slice(0, 2));
      expect(await error(c, ATTENDANT, 'select ops.check_minibar($1, $2)', [r101, two])).toMatch(
        /INVALID_LINES/,
      );
      expect(
        await error(c, ATTENDANT, 'select ops.check_minibar($1, $2)', [
          r101,
          await lines(c, -1, 2, 2),
        ]),
      ).toMatch(/INVALID_LINES/);
      const foreign = JSON.parse(await lines(c, 2, 2, 2)) as { item_id: string; left: number }[];
      foreign[2] = { item_id: await item(c, 'VODKA-750ML'), left: 1 };
      expect(
        await error(c, ATTENDANT, 'select ops.check_minibar($1, $2)', [
          r101,
          JSON.stringify(foreign),
        ]),
      ).toMatch(/INVALID_LINES/);
      expect(
        await error(c, ATTENDANT, 'select ops.check_minibar($1, $2)', [
          await room(c, '202'),
          await lines(c, 2, 2, 2),
        ]),
      ).toMatch(/NO_MINIBAR/);
    });
  });

  it("refills what the store has and says it's short; nothing used is nothing to charge", async () => {
    await inRolledBackTx(async (c) => {
      // the bar store down to one tonic
      const tonic = await item(c, 'TONIC-WATER-300ML');
      await c.query(
        `select inv.post($1, $2, 'count_adjust', 1 - inv.on_hand($1, $2), 0, 'test', null)`,
        [tonic, ids.node(BAR_STORE)],
      );
      const id = (
        await ok<{ id: string }>(c, ATTENDANT, 'select ops.check_minibar($1, $2) as id', [
          await room(c, '102'),
          await lines(c, 2, 2, 0),
        ])
      )[0]!.id;
      const task = await c.query<{ id: string }>(
        `select id from ops.task where minibar_check_id = $1 and kind = 'minibar_refill'`,
        [id],
      );
      const [refilled] = await ok<{ short: boolean }>(
        c,
        ATTENDANT,
        'select ops.refill_minibar($1) as short',
        [task.rows[0]!.id],
      );
      expect(refilled!.short).toBe(true);
      const line = await c.query<{ used: string; refilled: string }>(
        `select used_qty::text used, refilled_qty::text refilled from ops.minibar_check_line
          where check_id = $1 and item_id = $2`,
        [id, tonic],
      );
      expect(line.rows[0]).toEqual({ used: '2.000', refilled: '1.000' });
      expect(await onHand(c, 'TONIC-WATER-300ML')).toBe(0);
      const short = await c.query<{ short: boolean }>(
        `select short from ops.minibar_check where id = $1`,
        [id],
      );
      expect(short.rows[0]!.short).toBe(true);

      const none = (
        await ok<{ id: string }>(c, ATTENDANT, 'select ops.check_minibar($1, $2) as id', [
          await room(c, '103'),
          await lines(c, 2, 2, 2),
        ])
      )[0]!.id;
      const todo = await ok<{ id: string }>(
        c,
        FRONT_DESK,
        'select * from ops.minibar_to_charge($1)',
        [ids.node(HOTEL)],
      );
      expect(todo.map((t) => t.id)).toContain(id);
      expect(todo.map((t) => t.id)).not.toContain(none);
    });
  });
});

describe('charging and the usage report', () => {
  it('front office marks the charge added to the bill; the report adds up', async () => {
    await inRolledBackTx(async (c) => {
      const id = (
        await ok<{ id: string }>(c, ATTENDANT, 'select ops.check_minibar($1, $2) as id', [
          await room(c, '201'),
          await lines(c, 0, 1, 2),
        ])
      )[0]!.id;
      // a room attendant may mark too (same duty), but front office does it here
      await ok(c, FRONT_DESK, 'select ops.mark_minibar_charged($1)', [id]);
      const todo = await ok<{ id: string }>(
        c,
        FRONT_DESK,
        'select * from ops.minibar_to_charge($1)',
        [ids.node(HOTEL)],
      );
      expect(todo.map((t) => t.id)).not.toContain(id);
      const marked = await c.query<{ charged_by: string }>(
        `select charged_by from ops.minibar_check where id = $1`,
        [id],
      );
      expect(marked.rows[0]!.charged_by).toBe(ids.user(FRONT_DESK));
      expect(
        await error(c, 'test.commis.1.0', 'select ops.mark_minibar_charged($1)', [id]),
      ).toMatch(/NOT_AUTHORISED/);

      const usage = await ok<{ item: string; used: string; revenue: string }>(
        c,
        'test.general-manager.1.0',
        `select * from ops.minibar_usage($1, current_date - 7, current_date + 1)`,
        [ids.node(HOTEL)],
      );
      const by = new Map(usage.map((u) => [u.item, u]));
      // two beers at 250, one cola at 120
      expect(by.get('Test Lager Beer 330ml')).toMatchObject({ used: '2.000', revenue: '500.00' });
      expect(by.get('Test Cola 300ml')).toMatchObject({ used: '1.000', revenue: '120.00' });
      expect(by.has('Test Tonic Water 300ml')).toBe(false);
      const audit = await c.query(
        `select 1 from audit.log where table_name = 'ops.minibar_check' and row_id = $1`,
        [id],
      );
      expect(audit.rowCount).toBeGreaterThan(0);
    });
  });

  it('past checks are for test customers only', async () => {
    await inRolledBackTx(async (c) => {
      const t = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name, code, country, currency, default_timezone, is_test)
           values ('Real Hotel', 'REAL-MINIBAR', 'India', 'INR', 'Asia/Kolkata', false)
           returning id`,
        )
      ).rows[0]!.id;
      const u = (
        await c.query<{ id: string }>(
          `insert into core.app_user (tenant_id, kind, display_name) values ($1, 'human', 'Real')
           returning id`,
          [t],
        )
      ).rows[0]!.id;
      const r101 = await room(c, '101');
      await c.query('set local role platform_loader');
      await c.query(`select set_config('app.user_id', $1, true)`, [u]);
      await c.query('savepoint real');
      await expect(
        c.query(`select ops.record_test_minibar_check($1, '[]', now(), 'k')`, [r101]),
      ).rejects.toThrow(/NOT_A_TEST_CUSTOMER/);
      await c.query('rollback to savepoint real');
      await c.query('reset role');
    });
  });
});

describe('the refill and the bill are tasks (ADR 081)', () => {
  async function checkRoom(c: PoolClient, number: string) {
    return (
      await ok<{ id: string }>(c, ATTENDANT, 'select ops.check_minibar($1, $2) as id', [
        await room(c, number),
        await lines(c, 1, 2, 2),
      ])
    )[0]!.id;
  }
  const tasks = async (c: PoolClient, check: string) =>
    (
      await c.query<{
        id: string;
        kind: string;
        title: string;
        status: string;
        assignee_user_id: string | null;
        job_role_code: string | null;
      }>(
        `select id, kind, title, status, assignee_user_id, job_role_code from ops.task
          where minibar_check_id = $1 order by kind desc`,
        [check],
      )
    ).rows;

  it('a check that found something used: a refill for the attendant, a bill for the front desk', async () => {
    await inRolledBackTx(async (c) => {
      const id = await checkRoom(c, '101');
      const [refill, bill] = await tasks(c, id);
      expect(refill).toMatchObject({
        kind: 'minibar_refill',
        title: 'Refill minibar, room 101',
        status: 'open',
        assignee_user_id: ids.user(ATTENDANT),
      });
      expect(bill).toMatchObject({ kind: 'minibar_bill', status: 'open' });
      expect(bill!.title).toBe('Bill room 101: 1 Test Lager Beer 330ml');
      // with nobody on shift at the front desk now, it is the Front Desk Executives' job
      expect(bill!.assignee_user_id ?? bill!.job_role_code).toBeTruthy();
      // the front desk sees the bill on its list; the attendant's refill is theirs
      const fd = await ok<{ id: string }>(c, FRONT_DESK, 'select id from ops.my_tasks()');
      expect(fd.map((t) => t.id)).toContain(bill!.id);
      // nothing used, nothing to do
      const none = (
        await ok<{ id: string }>(c, ATTENDANT, 'select ops.check_minibar($1, $2) as id', [
          await room(c, '103'),
          await lines(c, 2, 2, 2),
        ])
      )[0]!.id;
      expect(await tasks(c, none)).toEqual([]);
    });
  });

  it('marked added to the bill: the bill task is done and housekeeping is told', async () => {
    await inRolledBackTx(async (c) => {
      const id = await checkRoom(c, '101');
      await ok(c, FRONT_DESK, 'select ops.mark_minibar_charged($1)', [id]);
      const [refill, bill] = await tasks(c, id);
      expect(bill!.status).toBe('done');
      expect(refill!.status).toBe('open');
      const told = await c.query<{ user_id: string; title: string }>(
        `select owner_user_id as user_id, title from ops.notification where kind = 'minibar_billed'
          and link = $1`,
        [`/tasks/${refill!.id}`],
      );
      expect(told.rows.map((r) => r.user_id)).toContain(ids.user(ATTENDANT));
      expect(told.rows[0]!.title).toBe('Room 101: minibar added to the bill');
    });
  });

  it('neither task closes through the generic Done; only its own refill or bill', async () => {
    await inRolledBackTx(async (c) => {
      const id = await checkRoom(c, '101');
      const [refill, bill] = await tasks(c, id);
      expect(await error(c, ATTENDANT, 'select ops.complete_task($1)', [refill!.id])).toMatch(
        /INVALID_STATE/,
      );
      // only whoever has the refill does it
      expect(await error(c, FRONT_DESK, 'select ops.refill_minibar($1)', [refill!.id])).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(await error(c, ATTENDANT, 'select ops.refill_minibar($1)', [bill!.id])).toMatch(
        /INVALID_STATE|NOT_AUTHORISED/,
      );
      // nobody outside the minibar duty marks it billed; another company sees nothing
      for (const who of ['test.commis.1.0', 'test.solo.bar-manager']) {
        expect(await error(c, who, 'select ops.mark_minibar_charged($1)', [id]), who).toMatch(
          /NOT_AUTHORISED/,
        );
        expect(
          await error(c, who, 'select * from ops.minibar_task_check($1)', [refill!.id]),
          who,
        ).toMatch(/NOT_AUTHORISED/);
      }
      const seen = await ok<{ room: string; charge: string }>(
        c,
        ATTENDANT,
        'select room, charge from ops.minibar_task_check($1)',
        [refill!.id],
      );
      expect(seen).toEqual([{ room: '101', charge: '250.00' }]);
    });
  });
});
