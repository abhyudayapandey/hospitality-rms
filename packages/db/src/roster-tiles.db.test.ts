import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The roster as tiles, shift types and "repeat this pattern" (GM item 4, ADR 082). Test
// Company's Hotel 1.0 restaurant has a Split shift (11:00-15:00, 18:00-23:00) for stewards and
// its bar a Panzer (19:00-04:00, a 30-minute break) for bartenders (file 16). A split shift is
// one shift with its gap as its break: two clock-in pairs on one shift, one shift worked, and
// rostered hours without the break. Putting someone on a tile runs every roster rule again.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const MANAGER = 'test.restaurant-manager.1.0';
const RESTAURANT = 'TEST-HOTEL-1.0-RESTAURANT';

async function worker(c: PoolClient, username: string): Promise<string> {
  const r = await c.query<{ id: string }>('select id from hr.worker where owner_user_id = $1', [
    ids.user(username),
  ]);
  return r.rows[0]!.id;
}

async function template(c: PoolClient, node: string, name: string, role: string) {
  const r = await c.query<{ id: string }>(
    `select id from hr.shift_template where org_node_id = $1 and name = $2 and role_code = $3`,
    [ids.node(node), name, role],
  );
  return r.rows[0]!.id;
}

/** A Monday some weeks ahead, clear of the test data's rostered weeks. */
async function mondayAhead(c: PoolClient, weeks: number): Promise<string> {
  const r = await c.query<{ d: string }>(
    `select (date_trunc('week', (now() at time zone 'Asia/Kolkata')::date)::date + $1 * 7)::text as d`,
    [weeks],
  );
  return r.rows[0]!.d;
}

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('shift types (file 16)', () => {
  it('a split shift: one shift, its gap as its break; a panzer crosses midnight', async () => {
    await inRolledBackTx(async (c) => {
      const monday = await mondayAhead(c, 5);
      const r = await attemptAs<{ id: string }>(
        c,
        ids.user(MANAGER),
        'select hr.set_day_shift($1, $2::date, $3) as id',
        [
          await worker(c, 'test.steward.1.0'),
          monday,
          await template(c, RESTAURANT, 'Split', 'STEWARD'),
        ],
      );
      expect(r.error).toBeUndefined();
      const s = await c.query<{
        shift_type: string;
        break_minutes: number;
        span: string;
        first: string;
        second: string;
      }>(
        `select s.shift_type, s.break_minutes,
                to_char(s.start_at at time zone 'Asia/Kolkata', 'HH24:MI') || '-' ||
                to_char(s.end_at at time zone 'Asia/Kolkata', 'HH24:MI') as span,
                to_char(s.split_end_at at time zone 'Asia/Kolkata', 'HH24:MI') as first,
                to_char(s.split_start_at at time zone 'Asia/Kolkata', 'HH24:MI') as second
           from hr.shift_assignment a join hr.shift s on s.id = a.shift_id where a.id = $1`,
        [r.rows![0]!.id],
      );
      expect(s.rows[0]).toEqual({
        shift_type: 'split',
        break_minutes: 180,
        span: '11:00-23:00',
        first: '15:00',
        second: '18:00',
      });
      const panzer = await c.query<{
        shift_type: string;
        first_end: string | null;
        break_minutes: number;
      }>(`select shift_type, first_end::text, break_minutes from hr.shift_template where id = $1`, [
        await template(c, 'TEST-HOTEL-1.0-BAR', 'Panzer', 'BARTENDER'),
      ]);
      expect(panzer.rows[0]).toEqual({ shift_type: 'panzer', first_end: null, break_minutes: 30 });
    });
  });

  it('a template of the wrong shape is refused by the database too', async () => {
    await inRolledBackTx(async (c) => {
      for (const [type, start, end, first, second] of [
        ['split', '11:00', '23:00', null, null],
        ['split', '11:00', '23:00', '19:00', '18:00'],
        ['panzer', '09:00', '17:00', null, null],
        ['straight', '09:00', '17:00', '12:00', '13:00'],
      ]) {
        await c.query('savepoint shape');
        await expect(
          c.query(
            `insert into hr.shift_template (tenant_id, org_node_id, name, role_code, start_time,
                                            end_time, shift_type, first_end, second_start)
             values ($1, $2, 'Bad', 'STEWARD', $3, $4, $5, $6, $7)`,
            [ids.tenant(), ids.node(RESTAURANT), start, end, type, first, second],
          ),
          `${type} ${start}-${end}`,
        ).rejects.toThrow(/shift_template_shape/);
        await c.query('rollback to savepoint shape');
      }
    });
  });

  it('two clock-in pairs on one split shift: no exceptions, one shift, hours without the break', async () => {
    await inRolledBackTx(async (c) => {
      const w = await worker(c, 'test.steward-c.1.0');
      const tpl = await template(c, RESTAURANT, 'Split', 'STEWARD');
      const day = (
        await c.query<{ d: string }>(
          `select ((now() at time zone 'Asia/Kolkata')::date - 3)::text as d`,
        )
      ).rows[0]!.d;
      const at = (t: string) => `${day} ${t}+05:30`;
      // the day's Split shift, as the templates made it (or made here), published
      await c.query(
        `insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                               role_code, headcount)
         values ($1, $2, $3, $4, $5, $6, 'STEWARD', 1)
         on conflict (template_id, local_date) where template_id is not null and status <> 'cancelled'
         do nothing`,
        [ids.tenant(), ids.node(RESTAURANT), tpl, day, at('11:00'), at('23:00')],
      );
      const shift = (
        await c.query<{ id: string }>(
          `update hr.shift set status = 'published', published_at = now()
            where template_id = $1 and local_date = $2 and status <> 'cancelled' returning id`,
          [tpl, day],
        )
      ).rows[0]!.id;
      await c.query(
        `update hr.shift_assignment set status = 'dropped', drop_reason = 'unassigned'
          where shift_id = $1 and status = 'assigned'`,
        [shift],
      );
      await c.query(
        `insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                          start_at, end_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ids.tenant(),
          shift,
          w,
          ids.user('test.steward-c.1.0'),
          ids.node(RESTAURANT),
          at('11:00'),
          at('23:00'),
        ],
      );
      for (const [i, o, k] of [
        ['10:58', '15:01', 'a'],
        ['17:57', '23:02', 'b'],
      ]) {
        await c.query(
          `insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, shift_id,
                                      clock_in_at, clock_out_at, in_source, out_source, in_key, out_key)
           values ($1, $2, $3, $4, $5, $6, $7, 'online', 'online', $8, $9)`,
          [
            ids.tenant(),
            w,
            ids.user('test.steward-c.1.0'),
            ids.node(RESTAURANT),
            shift,
            at(i!),
            at(o!),
            `split-in-${k}`,
            `split-out-${k}`,
          ],
        );
      }
      await c.query(`set local role wf_executor`);
      await c.query(`select * from hr.nightly_attendance()`);
      await c.query('reset role');
      const ex = await c.query<{ kind: string }>(
        'select kind from hr.attendance_exception where shift_id = $1',
        [shift],
      );
      expect(ex.rows).toEqual([]);
      // the labour report: one shift, 9 hours rostered (12 h less the 3 h break)
      const before = await c.query<{ shifts: number; hours: string; worked: string }>(
        `select shifts, scheduled_hours::text as hours, worked_hours::text as worked
           from rpt.calc_labour_day(array[$1]::uuid[], $2::date, $2::date)`,
        [ids.node(RESTAURANT), day],
      );
      await c.query(
        `update hr.shift set break_minutes = 0, shift_type = 'straight',
                            split_end_at = null, split_start_at = null where id = $1`,
        [shift],
      );
      const whole = await c.query<{ hours: string; shifts: number }>(
        `select shifts, scheduled_hours::text as hours
           from rpt.calc_labour_day(array[$1]::uuid[], $2::date, $2::date)`,
        [ids.node(RESTAURANT), day],
      );
      expect(Number(whole.rows[0]!.hours) - Number(before.rows[0]!.hours)).toBeCloseTo(3, 5);
      // still one shift either way: a split is one person on one shift (ADR 057)
      expect(whole.rows[0]!.shifts).toBe(before.rows[0]!.shifts);
    });
  });
});

describe('the tiles (hr.set_day_shift)', () => {
  it('on a tile, then another, then Off: one shift a day there, every rule run again', async () => {
    await inRolledBackTx(async (c) => {
      const monday = await mondayAhead(c, 5);
      const w = await worker(c, 'test.steward.1.0');
      const split = await template(c, RESTAURANT, 'Split', 'STEWARD');
      const breakfast = await template(c, RESTAURANT, 'Breakfast', 'STEWARD');
      const as = (sql: string, params: unknown[]) => attemptAs(c, ids.user(MANAGER), sql, params);
      expect(
        (await as('select hr.set_day_shift($1, $2::date, $3)', [w, monday, split])).error,
      ).toBeUndefined();
      // another tile the same day replaces it
      expect(
        (await as('select hr.set_day_shift($1, $2::date, $3)', [w, monday, breakfast])).error,
      ).toBeUndefined();
      const day = await as(`select hr.roster_day($1, $2::date) as d`, [
        ids.node(RESTAURANT),
        monday,
      ]);
      const people = (
        day.rows![0] as { d: { people: { worker_id: string; template_id: string | null }[] } }
      ).d.people;
      expect(people.find((p) => p.worker_id === w)!.template_id).toBe(breakfast);
      // the Split that day, then Breakfast the next morning: under 10 hours' rest, a warning
      await as('select hr.set_day_shift($1, $2::date, $3)', [w, monday, split]);
      const rest = await as('select hr.set_day_shift($1, $2::date, $3)', [
        w,
        addDays(monday, 1),
        breakfast,
      ]);
      expect(rest.error).toMatch(/REST/);
      const code = rest.error!;
      const ok = await as('select hr.set_day_shift($1, $2::date, $3, $4)', [
        w,
        addDays(monday, 1),
        breakfast,
        [code],
      ]);
      expect(ok.error).toBeUndefined();
      // Off
      expect(
        (await as('select hr.set_day_shift($1, $2::date, null)', [w, monday])).error,
      ).toBeUndefined();
      const after = await c.query<{ n: number }>(
        `select count(*)::int as n from hr.shift_assignment a join hr.shift s on s.id = a.shift_id
          where a.worker_id = $1 and a.status = 'assigned' and s.local_date = $2`,
        [w, monday],
      );
      expect(after.rows[0]!.n).toBe(0);
    });
  });

  it('a full shift takes one more for the manager; nobody else may set tiles', async () => {
    await inRolledBackTx(async (c) => {
      const monday = await mondayAhead(c, 5);
      const split = await template(c, RESTAURANT, 'Split', 'STEWARD');
      for (const u of ['test.steward.1.0', 'test.steward-b.1.0']) {
        const r = await attemptAs(
          c,
          ids.user(MANAGER),
          'select hr.set_day_shift($1, $2::date, $3)',
          [await worker(c, u), monday, split],
        );
        expect(r.error, u).toBeUndefined();
      }
      const hc = await c.query<{ headcount: number }>(
        `select headcount from hr.shift where template_id = $1 and local_date = $2`,
        [split, monday],
      );
      expect(hc.rows[0]!.headcount).toBe(2);
      for (const who of ['test.steward-c.1.0', 'test.commis.1.0', 'test.solo.bar-manager']) {
        const r = await attemptAs(c, ids.user(who), 'select hr.set_day_shift($1, $2::date, $3)', [
          await worker(c, 'test.steward.1.0'),
          addDays(monday, 2),
          split,
        ]);
        expect(r.error, who).toMatch(/NOT_AUTHORISED|INVALID_WORKER/);
      }
      // the day's tiles are read where the roster is (staff see their own department's);
      // another company reads nothing
      const day = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        'select hr.roster_day($1, $2::date)',
        [ids.node(RESTAURANT), monday],
      );
      expect(day.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});

describe('repeat this pattern', () => {
  it('copies a week onto the same weekdays; what a rule refuses is skipped and listed', async () => {
    await inRolledBackTx(async (c) => {
      const week = await mondayAhead(c, 5);
      const w = await worker(c, 'test.steward.1.0');
      const split = await template(c, RESTAURANT, 'Split', 'STEWARD');
      const breakfast = await template(c, RESTAURANT, 'Breakfast', 'STEWARD');
      const as = (sql: string, params: unknown[]) => attemptAs(c, ids.user(MANAGER), sql, params);
      await as('select hr.set_day_shift($1, $2::date, $3)', [w, week, split]);
      await as('select hr.set_day_shift($1, $2::date, $3)', [w, addDays(week, 2), breakfast]);
      // the next week's Tuesday: already on a Split, so Wednesday's Breakfast breaks the rest rule
      await as('select hr.set_day_shift($1, $2::date, $3)', [w, addDays(week, 8), split]);
      const r = await as(`select hr.repeat_pattern($1, $2::date, $3::date, $4::date) as r`, [
        ids.node(RESTAURANT),
        week,
        addDays(week, 7),
        addDays(week, 13),
      ]);
      expect(r.error).toBeUndefined();
      const out = (r.rows![0] as { r: { added: number; skipped: { day: string; code: string }[] } })
        .r;
      expect(out.added).toBe(1);
      expect(out.skipped.map((x) => [x.day, /REST/.test(x.code)])).toEqual([
        [addDays(week, 9), true],
      ]);
      // a range in the past, longer than eight weeks, or overlapping the week copied is refused
      for (const [from, to] of [
        [addDays(week, -50), addDays(week, -40)],
        [addDays(week, 7), addDays(week, 80)],
        [addDays(week, 3), addDays(week, 10)],
      ]) {
        const bad = await as(`select hr.repeat_pattern($1, $2::date, $3::date, $4::date)`, [
          ids.node(RESTAURANT),
          week,
          from,
          to,
        ]);
        expect(bad.error, `${from}..${to}`).toMatch(/INVALID_RANGE/);
      }
      const other = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        `select hr.repeat_pattern($1, $2::date, $3::date, $4::date)`,
        [ids.node(RESTAURANT), week, addDays(week, 7), addDays(week, 13)],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});
