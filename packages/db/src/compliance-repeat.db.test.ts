import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// A regular compliance job repeats every N months, every week or 2 weeks on a weekday, or on the
// nth (or last) weekday of each month (ADR 116); its reminder comes as far ahead as its rule
// suits. On Test Company's Hotel 1.0, where Compliance is in the plan (seed/dev/002).

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const GM = 'test.general-manager.1.0';
const H10 = 'TEST-HOTEL-1.0';

async function next(c: pg.PoolClient, rule: object, due: string, done: string): Promise<string> {
  const r = await c.query<{ d: string }>(
    `select ops.compliance_next(row(null, null, 'x', ($1::jsonb ->> 'every_months')::int, $2::date,
              'X', false, null, null, null, null, null, now(), null, now(), null, null,
              ($1::jsonb ->> 'every_weeks')::smallint, ($1::jsonb ->> 'nth')::smallint,
              ($1::jsonb ->> 'on_weekday')::smallint)::ops.compliance_item, $3::date)::text as d`,
    [JSON.stringify(rule), due, done],
  );
  return r.rows[0]!.d;
}

async function save(c: pg.PoolClient, rule: object, due: string) {
  return attemptAs<{ id: string }>(
    c,
    ids.user(GM),
    `select ops.save_compliance_job(null, $1, 'Grease trap clean', $2::jsonb, $3::date,
                                    'GENERAL_MANAGER', false) as id`,
    [ids.node(H10), JSON.stringify(rule), due],
  );
}

describe('how a regular job repeats (ADR 116)', () => {
  it('works out the next due date for each kind of rule', async () => {
    await inRolledBackTx(async (c) => {
      // months, from the day it was done (as before)
      expect(await next(c, { every_months: 3 }, '2026-01-15', '2026-01-20')).toBe('2026-04-20');
      // every Monday: done on Monday 12 Oct, next Monday; done late on Wednesday, still Monday
      expect(await next(c, { every_weeks: 1, on_weekday: 1 }, '2026-10-12', '2026-10-12')).toBe(
        '2026-10-19',
      );
      expect(await next(c, { every_weeks: 1, on_weekday: 1 }, '2026-10-12', '2026-10-14')).toBe(
        '2026-10-19',
      );
      // done early on Sunday: the Monday after the one it was due
      expect(await next(c, { every_weeks: 1, on_weekday: 1 }, '2026-10-12', '2026-10-11')).toBe(
        '2026-10-19',
      );
      // every 2 weeks on Monday
      expect(await next(c, { every_weeks: 2, on_weekday: 1 }, '2026-10-12', '2026-10-12')).toBe(
        '2026-10-26',
      );
      // the 2nd Tuesday: October's is the 13th, November's the 10th
      expect(await next(c, { nth: 2, on_weekday: 2 }, '2026-10-13', '2026-10-13')).toBe(
        '2026-11-10',
      );
      // the last Friday: October's is the 30th, November's the 27th
      expect(await next(c, { nth: -1, on_weekday: 5 }, '2026-10-30', '2026-10-29')).toBe(
        '2026-11-27',
      );
      // the 4th Thursday across a year end
      expect(await next(c, { nth: 4, on_weekday: 4 }, '2026-12-24', '2026-12-24')).toBe(
        '2027-01-28',
      );
    });
  });

  it('saves each rule, refuses a half one, and marks done to the next date', async () => {
    await inRolledBackTx(async (c) => {
      const weekly = await save(c, { every_weeks: 1, on_weekday: 1 }, '2026-10-12');
      expect(weekly.error).toBeUndefined();
      const row = await c.query(
        `select every_months, every_weeks, nth, on_weekday from ops.compliance_item where id = $1`,
        [weekly.rows![0]!.id],
      );
      expect(row.rows[0]).toEqual({ every_months: null, every_weeks: 1, nth: null, on_weekday: 1 });
      // read back by whoever keeps it
      const repeat = await attemptAs<{ every_weeks: number }>(
        c,
        ids.user(GM),
        `select every_weeks from ops.compliance_repeat($1)`,
        [[weekly.rows![0]!.id]],
      );
      expect(repeat.rows).toEqual([{ every_weeks: 1 }]);
      for (const bad of [
        { every_weeks: 1 },
        { nth: 2 },
        { every_weeks: 3, on_weekday: 1 },
        { every_months: 6, on_weekday: 1 },
        { every_months: 5 },
      ]) {
        expect((await save(c, bad, '2026-10-12')).error, JSON.stringify(bad)).toMatch(
          /INVALID_SCHEDULE/,
        );
      }
      // monthly through the same function, as before
      expect((await save(c, { every_months: 6 }, '2026-10-12')).error).toBeUndefined();
      // done: the next Monday
      await c.query(`update ops.compliance_item set next_due = current_date - 1 where id = $1`, [
        weekly.rows![0]!.id,
      ]);
      const done = await attemptAs<{ next: string }>(
        c,
        ids.user(GM),
        `select ops.mark_compliance_done($1, current_date - 1, '{}', null)::text as next`,
        [weekly.rows![0]!.id],
      );
      const want = await c.query<{ d: string }>(
        `select ((current_date - 1) + 1 + ((1 - extract(isodow from current_date)::int + 7) % 7))::text d`,
      );
      expect(done.rows![0]!.next).toBe(want.rows[0]!.d);
    });
  });

  it('reminds the day before a weekly job, a week before an nth-weekday one, 14 days before a monthly one', async () => {
    await inRolledBackTx(async (c) => {
      const mk = async (rule: object, inDays: number) => {
        const id = (await save(c, rule, '2026-10-12')).rows![0]!.id;
        await c.query(
          `update ops.compliance_item set next_due = ops.today_at(org_node_id) + $2::int where id = $1`,
          [id, inDays],
        );
        return id;
      };
      const weeklySoon = await mk({ every_weeks: 1, on_weekday: 1 }, 1);
      const weeklyLater = await mk({ every_weeks: 1, on_weekday: 1 }, 2);
      const nthSoon = await mk({ nth: 2, on_weekday: 2 }, 7);
      const nthLater = await mk({ nth: 2, on_weekday: 2 }, 8);
      const monthly = await mk({ every_months: 6 }, 14);
      await c.query(`select * from ops.compliance_tick()`);
      const reminded = async (id: string) =>
        (
          await c.query(`select 1 from ops.task where compliance_item_id = $1 and status = 'open'`, [
            id,
          ])
        ).rowCount;
      expect(await reminded(weeklySoon)).toBe(1);
      expect(await reminded(weeklyLater)).toBe(0);
      expect(await reminded(nthSoon)).toBe(1);
      expect(await reminded(nthLater)).toBe(0);
      expect(await reminded(monthly)).toBe(1);
    });
  });
});
