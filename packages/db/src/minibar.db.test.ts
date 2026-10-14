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
          {
            outlet_id: ids.node(HOTEL),
            outlet: 'Test Hotel & Bar 1.0',
            rooms: 5,
            can_check: true,
            // the rupees to charge are for whoever bills them: the front desk and the GM
            // (ADR 104), not housekeeping
            bills: u === FRONT_DESK || u === 'test.general-manager.1.0',
          },
        ]);
      }
      const area = await ok<{ can_check: boolean; bills: boolean }>(
        c,
        'test.area-manager',
        'select * from ops.minibar_places()',
      );
      expect(area.map((p) => [p.can_check, p.bills])).toEqual([[false, false]]);
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

describe('money only for whoever bills it or reads its cost (KI-09)', () => {
  it('the attendant sees what to charge, never the rupees; the front desk the charges; the GM the cost', async () => {
    await inRolledBackTx(async (c) => {
      const r = await room(c, '201');
      // one beer and one cola gone
      const id = (
        await ok<{ id: string }>(c, ATTENDANT, 'select ops.check_minibar($1, $2) as id', [
          r,
          await lines(c, 1, 1, 2),
        ])
      )[0]!.id;
      const refill = (
        await c.query<{ id: string }>(
          `select id from ops.task where minibar_check_id = $1 and kind = 'minibar_refill'`,
          [id],
        )
      ).rows[0]!.id;
      const outlet = ids.node(HOTEL);
      const look = async (u: string) => ({
        prices: (
          await ok<{ price: string | null }>(c, u, 'select price from ops.minibar_room($1)', [r])
        ).map((x) => x.price),
        history: (
          await ok<{ charge: string | null; used: unknown[] }>(
            c,
            u,
            'select charge, used from ops.minibar_history($1)',
            [r],
          )
        )[0]!,
        tile: (
          await ok<{ to_charge: string | null }>(
            c,
            u,
            'select to_charge from ops.minibar_rooms($1) where id = $2',
            [outlet, r],
          )
        )[0]!.to_charge,
        toCharge: (
          await ok<{ id: string; charge: string | null; used: { price?: string }[] }>(
            c,
            u,
            'select * from ops.minibar_to_charge($1)',
            [outlet],
          )
        ).find((x) => x.id === id)!,
        usage: await ok<{
          item: string;
          used: string;
          revenue: string | null;
          cost: string | null;
        }>(c, u, 'select * from ops.minibar_usage($1, current_date - 7, current_date + 1)', [
          outlet,
        ]),
      });

      const att = await look(ATTENDANT);
      expect(att.prices.every((p) => p === null)).toBe(true);
      expect(att.history.charge).toBeNull();
      expect(att.history.used).toHaveLength(2);
      expect(att.tile).toBeNull();
      expect(att.toCharge.charge).toBeNull();
      expect(att.toCharge.used.every((u) => u.price === undefined)).toBe(true);
      expect(att.usage.length).toBeGreaterThan(0);
      expect(att.usage.every((u) => u.revenue === null && u.cost === null)).toBe(true);
      const task = await ok<{ charge: string | null; used: { price?: string }[] }>(
        c,
        ATTENDANT,
        'select charge, used from ops.minibar_task_check($1)',
        [refill],
      );
      expect(task[0]!.charge).toBeNull();
      expect(task[0]!.used.every((u) => u.price === undefined)).toBe(true);

      // the front desk bills it: the guest's prices and the charge, not what it cost us
      const desk = await look(FRONT_DESK);
      expect(desk.prices.every((p) => p !== null)).toBe(true);
      expect(desk.history.charge).toBe('370.00');
      expect(desk.tile).toBe('370.00');
      expect(desk.toCharge.charge).toBe('370.00');
      expect(desk.usage.every((u) => u.revenue !== null && u.cost === null)).toBe(true);

      // the GM reads the bar store's cost too
      const gm = await look('test.general-manager.1.0');
      expect(gm.history.charge).toBe('370.00');
      expect(gm.usage.every((u) => u.revenue !== null && u.cost !== null)).toBe(true);
    });
  });

  it('nothing to charge reads 0 for everyone', async () => {
    await inRolledBackTx(async (c) => {
      const r = await room(c, '201');
      await ok(c, ATTENDANT, 'select ops.check_minibar($1, $2)', [r, await lines(c, 2, 2, 2)]);
      const [h] = await ok<{ charge: string | null }>(
        c,
        ATTENDANT,
        'select charge from ops.minibar_history($1)',
        [r],
      );
      expect(Number(h!.charge)).toBe(0);
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

/** The front desk executive on a published shift that started an hour ago, and clocked in, so
 * the bill is theirs whatever the time of day (ADR 144: a bill goes to whoever is on shift). */
async function frontDeskOnShift(c: PoolClient) {
  const user = ids.user(FRONT_DESK);
  // their other shifts today step aside (the test rolls back), so no overlap rule refuses it
  await c.query(
    `delete from hr.shift_assignment
      where owner_user_id = $1 and end_at > now() - interval '1 day'
        and start_at < now() + interval '1 day'`,
    [user],
  );
  await c.query(
    `with w as (select * from hr.worker where owner_user_id = $1 and status = 'active' limit 1),
     s as (insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code,
                                 status, published_at)
           select tenant_id, org_node_id,
                  ((now() - interval '1 hour') at time zone 'Asia/Kolkata')::date,
                  now() - interval '1 hour', now() + interval '7 hours', role_code, 'published',
                  now() from w returning *),
     a as (insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id,
                                            org_node_id, start_at, end_at)
           select s.tenant_id, s.id, w.id, w.owner_user_id, s.org_node_id, s.start_at, s.end_at
             from s, w returning 1)
     insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, clock_in_at,
                                in_source, in_key)
     select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, now() - interval '1 hour',
            'online', 'test-front-desk-on-shift'
       from w where exists (select 1 from a)`,
    [user],
  );
}

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
      await frontDeskOnShift(c);
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
      // the front desk executive on shift has it
      expect(bill!.assignee_user_id).toBe(ids.user(FRONT_DESK));
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
      await frontDeskOnShift(c);
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
      // the attendant sees the room, not the rupees (KI-09); the front desk sees both
      const seen = await ok<{ room: string; charge: string | null }>(
        c,
        ATTENDANT,
        'select room, charge from ops.minibar_task_check($1)',
        [refill!.id],
      );
      expect(seen).toEqual([{ room: '101', charge: null }]);
      const billed = await ok<{ room: string; charge: string | null }>(
        c,
        FRONT_DESK,
        'select room, charge from ops.minibar_task_check($1)',
        [bill!.id],
      );
      expect(billed).toEqual([{ room: '101', charge: '250.00' }]);
    });
  });
});

describe('due a check today (ADR 104)', () => {
  it('a room with a minibar and a guest in, arriving or leaving, until it is checked today', async () => {
    await inRolledBackTx(async (c) => {
      const due = async () =>
        (
          await ok<{ number: string; status: string; due_today: boolean }>(
            c,
            ATTENDANT,
            'select number, status, due_today from ops.minibar_rooms($1)',
            [ids.node(HOTEL)],
          )
        )
          .filter((r) => r.due_today)
          .map((r) => r.number);
      await c.query(
        `delete from ops.room_status where room_id in (
                       select id from ops.room where org_node_id = $1)`,
        [ids.node(HOTEL)],
      );
      // every room clean and empty: nothing due
      expect(await due()).toEqual([]);
      for (const [n, s] of [
        ['101', 'OCC'],
        ['102', 'DEP'],
        ['103', 'VD'],
        ['202', 'OCC'], // no minibar
      ] as const) {
        await ok(c, FRONT_DESK, 'select ops.set_room_status($1, $2)', [await room(c, n), s]);
      }
      expect(await due()).toEqual(['101', '102']);
      const [r] = await ok<{ status: string }>(
        c,
        ATTENDANT,
        'select status from ops.minibar_rooms($1) where number = $2',
        [ids.node(HOTEL), '101'],
      );
      expect(r!.status).toBe('OCC');
      // checked today: no longer due
      await ok(c, ATTENDANT, 'select ops.check_minibar($1, $2)', [
        await room(c, '101'),
        await lines(c, 2, 2, 2),
      ]);
      expect(await due()).toEqual(['102']);
    });
  });
});

describe('who hears about a bill, and who gets it (QA of the hotel demo)', () => {
  const told = async (c: PoolClient, user: string, task: string) =>
    (
      await c.query<{ kind: string }>(
        `select kind from ops.notification where owner_user_id = $1 and link = $2`,
        [ids.user(user), `/tasks/${task}`],
      )
    ).rows.map((r) => r.kind);

  it('the attendant who checked is never told the bill is overdue, nor that it is done', async () => {
    await inRolledBackTx(async (c) => {
      const check = (
        await ok<{ id: string }>(c, ATTENDANT, 'select ops.check_minibar($1, $2) as id', [
          await room(c, '101'),
          await lines(c, 0, 2, 2),
        ])
      )[0]!.id;
      const bill = (
        await c.query<{ id: string }>(
          `select id from ops.task where minibar_check_id = $1 and kind = 'minibar_bill'`,
          [check],
        )
      ).rows[0]!.id;
      // routed, not handed on: not on the attendant's "Given to others"
      const handed = await ok<{ id: string }>(c, ATTENDANT, 'select id from ops.my_handed_on()');
      expect(handed.map((t) => t.id)).not.toContain(bill);
      // two hours on, overdue and overdue by an hour
      await c.query(`set local role wf_executor`);
      await c.query(`select * from ops.tasks_tick(now() + interval '3 hours')`);
      await c.query('reset role');
      expect(await told(c, ATTENDANT, bill)).not.toContain('task_overdue');
      // whoever answers for the front office still hears it
      const heads = (
        await c.query<{ n: number }>(
          `select count(*)::int as n from ops.notification
            where link = $1 and kind = 'task_overdue'`,
          [`/tasks/${bill}`],
        )
      ).rows[0]!.n;
      expect(heads).toBeGreaterThan(0);
      await ok(c, FRONT_DESK, 'select ops.mark_minibar_charged($1)', [check]);
      expect(await told(c, ATTENDANT, bill)).not.toContain('task_done');
    });
  });

  it('a bill goes to whoever is on the desk now or later today, never someone off till tomorrow', async () => {
    await inRolledBackTx(async (c) => {
      const dept = (
        await c.query<{ id: string }>(`select department as id from ops.minibar_biller($1)`, [
          ids.node(HOTEL),
        ])
      ).rows[0]!.id;
      const shifts = (
        await c.query<{ start_at: Date; end_at: Date }>(
          `select a.start_at, a.end_at from hr.shift_assignment a
             join hr.shift s on s.id = a.shift_id and s.status = 'published'
            where a.owner_user_id = $1 and a.status = 'assigned'
              and extract(hour from a.start_at at time zone 'Asia/Kolkata') >= 6
            order by a.start_at limit 1`,
          [ids.user(FRONT_DESK)],
        )
      ).rows;
      expect(shifts.length).toBeGreaterThan(0);
      const s = shifts[0]!;
      const next = async (at: Date) =>
        (
          await c.query<{ person: string; starts_at: Date }>(
            `select person, starts_at from ops.on_shift_next($1, $2, $3)`,
            [dept, ['FRONT_DESK_EXECUTIVE', 'FRONT_OFFICE_MANAGER'], at],
          )
        ).rows[0];
      // an hour before the shift: whoever is on now, else the shift that starts later today
      const before = await next(new Date(s.start_at.getTime() - 3_600_000));
      expect(before).toBeDefined();
      expect(before!.starts_at.getTime()).toBeLessThanOrEqual(s.start_at.getTime());
      // during it: someone on shift then
      const during = await next(new Date(s.start_at.getTime() + 60_000));
      expect(during!.starts_at.getTime()).toBeLessThanOrEqual(s.start_at.getTime() + 60_000);
      // a business day before, at 05:00, the shift that starts the next day is not given it
      const dayBefore = new Date(s.start_at.getTime() - 86_400_000);
      const early = await next(dayBefore);
      if (early) expect(early.starts_at.getTime()).toBeLessThan(s.start_at.getTime() - 3_600_000);
    });
  });

  it("the loader's replay of a past check tells nobody and keeps the file's times", async () => {
    await inRolledBackTx(async (c) => {
      const at = '2026-10-01T05:00:00Z';
      // as the loader does it: platform_loader, as the people in file 42, app.replay on
      const asLoader = async (user: string, sql: string, params: unknown[]) => {
        await c.query('set local role platform_loader');
        await c.query(`select set_config('app.user_id', $1, true)`, [ids.user(user)]);
        const r = await c.query<{ id: string }>(sql, params);
        await c.query('reset role');
        await c.query(`select set_config('app.user_id', '', true)`);
        return r.rows[0];
      };
      await c.query(`select set_config('app.replay', 'on', true)`);
      const check = (await asLoader(
        ATTENDANT,
        `select ops.record_test_minibar_check($1, $2, $3::timestamptz, 'replay-test') as id`,
        [await room(c, '101'), await lines(c, 0, 2, 2), at],
      ))!.id;
      await c.query(`select set_config('app.occurred_at', '2026-10-01T05:30:00Z', true)`);
      await asLoader(FRONT_DESK, 'select ops.mark_minibar_charged($1)', [check]);
      const row = (
        await c.query<{ charged_at: Date }>(
          `select charged_at from ops.minibar_check where id = $1`,
          [check],
        )
      ).rows[0]!;
      expect(row.charged_at.toISOString()).toBe('2026-10-01T05:30:00.000Z');
      const notes = await c.query(
        `select 1 from ops.notification n join ops.task t on n.link = '/tasks/' || t.id
          where t.minibar_check_id = $1`,
        [check],
      );
      expect(notes.rowCount).toBe(0);
      // live again: people are told
      await c.query(`select set_config('app.replay', '', true)`);
      await c.query(`select ops.notify($1, $2, 'test', 'Live')`, [
        ids.tenant(),
        ids.user(ATTENDANT),
      ]);
      expect((await c.query(`select 1 from ops.notification where title = 'Live'`)).rowCount).toBe(
        1,
      );
    });
  });
});
