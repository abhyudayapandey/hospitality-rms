import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Task lists by the 04:00 business day (ADR 164): a Lock-up due at 00:00 belongs to the day
// before, in Team tasks, its late counts and the completion table's week.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const PLACE = 'TEST-BAR-3.0-FLOOR-SERVICE';
const MANAGER = 'test.bar-manager.3.0';

/** The business day `days` from today at the place, as a date string. */
async function day(c: pg.PoolClient, days: number): Promise<string> {
  const { rows } = await c.query<{ d: string }>(`select (rpt.today($1) + $2::int)::text d`, [
    ids.node(PLACE),
    days,
  ]);
  return rows[0]!.d;
}

/** A task at the place due at local `hhmm` on calendar day `date`. */
async function task(c: pg.PoolClient, date: string, hhmm: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,
                           job_role_code)
     values ($1, $2, 'one_off', 'Lock-up test', ($3::date + $4::time) at time zone 'Asia/Kolkata',
             'job_role', 'SERVER')
     returning id`,
    [ids.tenant(), ids.node(PLACE), date, hhmm],
  );
  return rows[0]!.id;
}

async function as<T extends object>(c: pg.PoolClient, sql: string, params: unknown[]) {
  const r = await attemptAs<T>(c, ids.user(MANAGER), sql, params);
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows;
}

const listed = async (c: pg.PoolClient, from: string, to: string) =>
  (
    await as<{ id: string }>(c, 'select id from ops.team_tasks($1, $2::date, $3::date)', [
      ids.node(PLACE),
      from,
      to,
    ])
  ).map((r) => r.id);

const late = async (c: pg.PoolClient, from: string, to: string) => {
  const [one] = await as<{ n: number }>(c, 'select ops.late_count($1, $2::date, $3::date) n', [
    ids.node(PLACE),
    from,
    to,
  ]);
  const [many] = await as<{ n: number }>(
    c,
    'select n from ops.late_counts(array[$1]::uuid[], $2::date, $3::date)',
    [ids.node(PLACE), from, to],
  );
  expect(many!.n).toBe(one!.n); // the tiles and the list count alike
  return one!.n;
};

describe('task lists by the business day', () => {
  it("a task due at 00:00 is the night before's, 03:59 too, 04:00 the new day's", async () => {
    await inRolledBackTx(async (c) => {
      const d = await day(c, 3);
      const next = await day(c, 4);
      const midnight = await task(c, next, '00:00');
      const before4 = await task(c, next, '03:59');
      const at4 = await task(c, next, '04:00');
      const evening = await task(c, d, '23:00');
      const onD = await listed(c, d, d);
      expect(onD).toEqual(expect.arrayContaining([evening, midnight, before4]));
      expect(onD).not.toContain(at4);
      const onNext = await listed(c, next, next);
      expect(onNext).toContain(at4);
      expect(onNext).not.toContain(midnight);
      expect(onNext).not.toContain(before4);
    });
  });

  it('a late Lock-up counts on the day it closed, in the late counts too', async () => {
    await inRolledBackTx(async (c) => {
      const twoAgo = await day(c, -2);
      const yesterday = await day(c, -1);
      const [beforeTwo, beforeOne] = [
        await late(c, twoAgo, twoAgo),
        await late(c, yesterday, yesterday),
      ];
      // due 00:30 on yesterday's calendar day: the business day before it
      await task(c, yesterday, '00:30');
      expect(await late(c, twoAgo, twoAgo)).toBe(beforeTwo + 1);
      expect(await late(c, yesterday, yesterday)).toBe(beforeOne);
    });
  });

  it("the completion table's week starts on Monday at 04:00", async () => {
    await inRolledBackTx(async (c) => {
      // the Monday two weeks back, and its Sunday night's 02:00 (calendar Monday)
      const { rows } = await c.query<{ mon: string; prev: string }>(
        `select hr.week_start(rpt.today($1) - 14)::text mon,
                (hr.week_start(rpt.today($1) - 14) - 7)::text prev`,
        [ids.node(PLACE)],
      );
      const { mon, prev } = rows[0]!;
      const due = async (week: string) =>
        (
          await as<{ org_node_id: string; due: number }>(
            c,
            'select org_node_id, due from ops.completion($1, $2::date)',
            [ids.node(PLACE), week],
          )
        ).find((r) => r.org_node_id === ids.node(PLACE))?.due ?? 0;
      const [m0, p0] = [await due(mon), await due(prev)];
      await task(c, mon, '02:00');
      expect(await due(mon)).toBe(m0);
      expect(await due(prev)).toBe(p0 + 1);
    });
  });
});
