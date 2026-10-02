import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { clearWorkforce, newWorker, tenantOf, workerFor, type JobRole } from '../test/workforce';

// Rostering (ADR 008): week generation in the node's timezone, every assignment rule,
// tenant-configured limits, publish and the notifications it sends.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const OLIVIA = () => ids.user('test.bar-manager.3.0');

/** A Monday two weeks ahead (Asia/Kolkata), so every shift is in the future. */
async function futureMonday(c: PoolClient): Promise<string> {
  const { rows } = await c.query<{ d: string }>(
    `select (hr.week_start((now() at time zone 'Asia/Kolkata')::date) + 14)::text as d`,
  );
  return rows[0]!.d;
}

/** A draft shift in Test Bar 3.0's Floor Service starting `day` (offset from monday) at local `time`. */
async function shift(
  c: PoolClient,
  monday: string,
  day: number,
  time: string,
  hours: number,
  role: JobRole = 'SERVER',
  opts: { node?: string; headcount?: number } = {},
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code, headcount)
     select n.tenant_id, n.id, $2::date + $3::int,
            ($2::date + $3::int + $4::time) at time zone 'Asia/Kolkata',
            ($2::date + $3::int + $4::time) at time zone 'Asia/Kolkata' + make_interval(hours => $5),
            $6, $7
       from core.hierarchy_node n where n.id = $1 returning id`,
    [
      ids.node(opts.node ?? 'TEST-BAR-3.0-FLOOR-SERVICE'),
      monday,
      day,
      time,
      hours,
      role,
      opts.headcount ?? 1,
    ],
  );
  return rows[0]!.id;
}

async function assign(c: PoolClient, shiftId: string, workerId: string, as = OLIVIA()) {
  return attemptAs<{ id: string }>(c, as, 'select hr.assign($1, $2) as id', [shiftId, workerId]);
}

describe('hr.generate_week', () => {
  it('builds draft shifts from templates in the node timezone, once', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const tenant = await tenantOf(c, ids);
      await workerFor(c, ids, 'test.server.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE', 'SERVER');
      const monday = await futureMonday(c);
      await c.query(
        `insert into hr.shift_template (tenant_id, org_node_id, name, role_code, start_time,
                                        end_time, headcount, weekdays)
         values ($1, $2, 'Day', 'SERVER', '09:00', '17:00', 2, '{1,2,3,4,5,6,7}'),
                ($1, $2, 'Night', 'COOK', '22:00', '06:00', 1, '{1}')`,
        [tenant, ids.node('TEST-BAR-3.0-FLOOR-SERVICE')],
      );
      const gen = await attemptAs<{ n: number }>(
        c,
        OLIVIA(),
        'select hr.generate_week($1, $2) as n',
        [ids.node('TEST-BAR-3.0-FLOOR-SERVICE'), monday],
      );
      expect(gen.rows![0]!.n).toBe(8);
      const { rows } = await c.query<{
        role_code: string;
        s: string;
        e: string;
        hc: number;
        status: string;
      }>(
        `select role_code, to_char(start_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') s,
                to_char(end_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') e,
                headcount hc, status
           from hr.shift where org_node_id = $1 and local_date = $2::date order by start_at`,
        [ids.node('TEST-BAR-3.0-FLOOR-SERVICE'), monday],
      );
      const next = (await c.query<{ d: string }>(`select ($1::date + 1)::text d`, [monday]))
        .rows[0]!.d;
      expect(rows).toEqual([
        { role_code: 'SERVER', s: `${monday} 09:00`, e: `${monday} 17:00`, hc: 2, status: 'draft' },
        { role_code: 'COOK', s: `${monday} 22:00`, e: `${next} 06:00`, hc: 1, status: 'draft' },
      ]);
      // stored in UTC: 09:00 IST = 03:30Z
      const utc = await c.query<{ h: string }>(
        `select to_char(start_at at time zone 'UTC', 'HH24:MI') h from hr.shift
          where org_node_id = $1 and local_date = $2::date and role_code = 'SERVER'`,
        [ids.node('TEST-BAR-3.0-FLOOR-SERVICE'), monday],
      );
      expect(utc.rows[0]!.h).toBe('03:30');

      const again = await attemptAs<{ n: number }>(
        c,
        OLIVIA(),
        'select hr.generate_week($1, $2) as n',
        [ids.node('TEST-BAR-3.0-FLOOR-SERVICE'), monday],
      );
      expect(again.rows![0]!.n).toBe(0);
    });
  });

  it('rejects non-Monday weeks, staff and other outlets', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const monday = await futureMonday(c);
      const tuesday = (await c.query<{ d: string }>(`select ($1::date + 1)::text d`, [monday]))
        .rows[0]!.d;
      const gen = 'select hr.generate_week($1, $2)';
      expect(
        (await attemptAs(c, OLIVIA(), gen, [ids.node('TEST-BAR-3.0-FLOOR-SERVICE'), tuesday]))
          .error,
      ).toBe('INVALID_WEEK');
      expect(
        (
          await attemptAs(c, ids.user('test.server.3.0'), gen, [
            ids.node('TEST-BAR-3.0-FLOOR-SERVICE'),
            monday,
          ])
        ).error,
      ).toBe('NOT_AUTHORISED');
      expect(
        (await attemptAs(c, OLIVIA(), gen, [ids.node('TEST-GUEST-HOUSE-2.0'), monday])).error,
      ).toBe('NOT_AUTHORISED');
      // Aria has ROSTER view only
      expect(
        (
          await attemptAs(c, ids.user('test.area-manager'), gen, [
            ids.node('TEST-BAR-3.0-FLOOR-SERVICE'),
            monday,
          ])
        ).error,
      ).toBe('NOT_AUTHORISED');
    });
  });
});

describe('template shifts for the next seven days (ADR 024)', () => {
  const FLOOR = () => ids.node('TEST-BAR-3.0-FLOOR-SERVICE');

  /** A fresh template every day at Floor Service, the only one there. */
  async function everyDay(c: PoolClient): Promise<string> {
    await c.query(`update hr.shift_template set archived_at = now() where org_node_id = $1`, [
      FLOOR(),
    ]);
    const { rows } = await c.query<{ id: string }>(
      `insert into hr.shift_template (tenant_id, org_node_id, name, role_code, start_time,
                                      end_time, headcount, weekdays)
       values ($1, $2, 'Window', 'SERVER', '09:00', '17:00', 1, '{1,2,3,4,5,6,7}') returning id`,
      [await tenantOf(c, ids), FLOOR()],
    );
    return rows[0]!.id;
  }

  async function today(c: PoolClient): Promise<string> {
    return (
      await c.query<{ d: string }>(`select (now() at time zone 'Asia/Kolkata')::date::text d`)
    ).rows[0]!.d;
  }

  it('adds tomorrow to day 7 only, never today or a past day, after a preview', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const tpl = await everyDay(c);
      const preview = await attemptAs<{
        to_add: number;
        drafts: number;
        from_day: string;
        to_day: string;
      }>(
        c,
        OLIVIA(),
        `select to_add, drafts, from_day::text, to_day::text from hr.preview_template_shifts($1)`,
        [FLOOR()],
      );
      const t = await today(c);
      const plus = async (n: number) =>
        (await c.query<{ d: string }>(`select ($1::date + $2::int)::text d`, [t, n])).rows[0]!.d;
      expect(preview.rows![0]).toEqual({
        to_add: 7,
        drafts: 0,
        from_day: await plus(1),
        to_day: await plus(7),
      });
      // the preview adds nothing
      const none = await c.query(`select 1 from hr.shift where template_id = $1`, [tpl]);
      expect(none.rowCount).toBe(0);

      const add = await attemptAs<{ n: number }>(
        c,
        OLIVIA(),
        'select hr.add_template_shifts($1) as n',
        [FLOOR()],
      );
      expect(add.rows![0]!.n).toBe(7);
      const { rows } = await c.query<{ min: string; max: string; drafts: number }>(
        `select min(local_date)::text min, max(local_date)::text max,
                count(*) filter (where status = 'draft')::int drafts
           from hr.shift where template_id = $1`,
        [tpl],
      );
      expect(rows[0]).toEqual({ min: await plus(1), max: await plus(7), drafts: 7 });
      // twice adds nothing more
      const again = await attemptAs<{ n: number }>(
        c,
        OLIVIA(),
        'select hr.add_template_shifts($1) as n',
        [FLOOR()],
      );
      expect(again.rows![0]!.n).toBe(0);
    });
  });

  it('discard cancels the drafts in the window, frees people, leaves published shifts', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
      const tpl = await everyDay(c);
      await attemptAs(c, OLIVIA(), 'select hr.add_template_shifts($1)', [FLOOR()]);
      const shifts = (
        await c.query<{ id: string }>(
          `select id from hr.shift where template_id = $1 order by local_date`,
          [tpl],
        )
      ).rows.map((r) => r.id);
      // one published shift, one draft with Sam on it
      await c.query(
        `update hr.shift set status = 'published', published_at = now() where id = $1`,
        [shifts[0]],
      );
      const assigned = await assign(c, shifts[1]!, sam);
      expect(assigned.error).toBeUndefined();
      const before = await c.query<{ n: number }>(
        `select count(*)::int n from ops.notification where owner_user_id = $1`,
        [ids.user('test.server.3.0')],
      );

      const preview = await attemptAs<{ drafts: number }>(
        c,
        OLIVIA(),
        'select drafts from hr.preview_template_shifts($1)',
        [FLOOR()],
      );
      expect(preview.rows![0]!.drafts).toBe(6);
      const gone = await attemptAs<{ n: number }>(
        c,
        OLIVIA(),
        'select hr.discard_drafts($1) as n',
        [FLOOR()],
      );
      expect(gone.rows![0]!.n).toBe(6);
      const { rows } = await c.query<{ status: string; n: number }>(
        `select status, count(*)::int n from hr.shift where template_id = $1
          group by status order by status`,
        [tpl],
      );
      expect(rows).toEqual([
        { status: 'cancelled', n: 6 },
        { status: 'published', n: 1 },
      ]);
      const a = await c.query<{ status: string; drop_reason: string }>(
        `select status, drop_reason from hr.shift_assignment where shift_id = $1`,
        [shifts[1]],
      );
      expect(a.rows).toEqual([{ status: 'dropped', drop_reason: 'shift_cancelled' }]);
      const after = await c.query<{ n: number }>(
        `select count(*)::int n from ops.notification where owner_user_id = $1`,
        [ids.user('test.server.3.0')],
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

      // a discarded day can be added again
      const re = await attemptAs<{ n: number }>(
        c,
        OLIVIA(),
        'select hr.add_template_shifts($1) as n',
        [FLOOR()],
      );
      expect(re.rows![0]!.n).toBe(6);
    });
  });

  it('only people who build the roster there', async () => {
    await inRolledBackTx(async (c) => {
      for (const fn of [
        'select * from hr.preview_template_shifts($1)',
        'select hr.add_template_shifts($1)',
        'select hr.discard_drafts($1)',
      ]) {
        for (const [user, node] of [
          ['test.server.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE'],
          ['test.area-manager', 'TEST-BAR-3.0-FLOOR-SERVICE'],
          ['test.bar-manager.3.0', 'TEST-GUEST-HOUSE-2.0'],
          ['test.solo.bar-manager', 'TEST-BAR-3.0-FLOOR-SERVICE'],
        ] as const) {
          const r = await attemptAs(c, ids.user(user), fn, [ids.node(node)]);
          expect(r.error, `${user} ${fn}`).toBe('NOT_AUTHORISED');
        }
      }
    });
  });
});

describe('hr.assign rules', () => {
  it('ROLE_MISMATCH, WORKER_NOT_AT_NODE and SHIFT_STARTED', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
      const monday = await futureMonday(c);
      expect((await assign(c, await shift(c, monday, 0, '09:00', 8, 'COOK'), sam)).error).toBe(
        'ROLE_MISMATCH',
      );
      // Olivia cannot touch Outlet B; the area level cannot either (view only)
      const outletB = await shift(c, monday, 0, '09:00', 8, 'SERVER', {
        node: 'TEST-GUEST-HOUSE-2.0',
      });
      expect((await assign(c, outletB, sam)).error).toBe('NOT_AUTHORISED');
      // a manager with ROSTER modify at B still cannot roster Sam there
      const omar = await newWorker(c, ids, 'Omar B Manager', 'TEST-GUEST-HOUSE-2.0', 'MANAGER', [
        ['OUTLET_MANAGER', 'TEST-GUEST-HOUSE-2.0'],
      ]);
      expect((await assign(c, outletB, sam, omar.userId)).error).toBe('WORKER_NOT_AT_NODE');
      const past = await c.query<{ id: string }>(
        `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code)
         select tenant_id, id, current_date - 1, now() - interval '1 day',
                now() - interval '16 hours', 'SERVER'
           from core.hierarchy_node where id = $1 returning id`,
        [ids.node('TEST-BAR-3.0-FLOOR-SERVICE')],
      );
      expect((await assign(c, past.rows[0]!.id, sam)).error).toBe('SHIFT_STARTED');
    });
  });

  it('SHIFT_OVERLAP and REST_RULE (10 h default, tenant config overrides)', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
      const monday = await futureMonday(c);
      expect((await assign(c, await shift(c, monday, 0, '09:00', 8), sam)).error).toBeUndefined();
      expect((await assign(c, await shift(c, monday, 0, '16:00', 4), sam)).error).toBe(
        'SHIFT_OVERLAP',
      );
      // ends 17:00; 02:00 next day is 9 h later
      const nine = await shift(c, monday, 1, '02:00', 6);
      const r = await assign(c, nine, sam);
      expect(r.error).toBe('REST_RULE');
      // exactly 10 h is fine
      const ten = await assign(c, await shift(c, monday, 1, '03:00', 5), sam);
      expect(ten.error).toBeUndefined();

      const tenant = await tenantOf(c, ids);
      await c.query(
        `insert into hr.roster_setting (tenant_id, min_rest_hours) values ($1, 8)
         on conflict (tenant_id) do update set min_rest_hours = 8`,
        [tenant],
      );
      // with 8 h minimum, a 9 h gap passes the rest rule (it now overlaps nothing either)
      await attemptAs(c, OLIVIA(), 'select hr.unassign($1)', [ten.rows![0]!.id]);
      expect((await assign(c, nine, sam)).error).toBeUndefined();
    });
  });

  it('WEEKLY_HOURS_CAP: 48 h passes, the next shift does not; the cap is tenant config', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
      const monday = await futureMonday(c);
      for (let d = 0; d < 6; d++) {
        expect((await assign(c, await shift(c, monday, d, '09:00', 8), sam)).error).toBeUndefined();
      }
      const sunday = await shift(c, monday, 6, '09:00', 4);
      const r = await assign(c, sunday, sam);
      expect(r.error).toBe('WEEKLY_HOURS_CAP');
      // the next week starts again at zero
      expect((await assign(c, await shift(c, monday, 7, '09:00', 8), sam)).error).toBeUndefined();

      await c.query(
        `insert into hr.roster_setting (tenant_id, weekly_hours_cap) values ($1, 60)
         on conflict (tenant_id) do update set weekly_hours_cap = 60`,
        [await tenantOf(c, ids)],
      );
      expect((await assign(c, sunday, sam)).error).toBeUndefined();
    });
  });

  it('rest and weekly hours are warnings: assign anyway by naming them (ADR 019)', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
      const monday = await futureMonday(c);
      expect((await assign(c, await shift(c, monday, 0, '09:00', 8), sam)).error).toBeUndefined();
      await c.query(
        `insert into hr.roster_setting (tenant_id, weekly_hours_cap) values ($1, 12)
         on conflict (tenant_id) do update set weekly_hours_cap = 12`,
        [await tenantOf(c, ids)],
      );
      // 9 h after the 17:00 end, and 14 h that week
      const late = await shift(c, monday, 1, '02:00', 6);
      const anyway = (accept: string) =>
        attemptAs<{ id: string }>(c, OLIVIA(), 'select hr.assign($1, $2, $3) as id', [
          late,
          sam,
          accept,
        ]);
      expect((await anyway('{}')).error).toBe('REST_RULE');
      expect((await anyway('{REST_RULE}')).error).toBe('WEEKLY_HOURS_CAP');
      const ok = await anyway('{REST_RULE,WEEKLY_HOURS_CAP}');
      expect(ok.error).toBeUndefined();
      const a = await c.query<{ w: string[] }>(
        'select warnings_accepted w from hr.shift_assignment where id = $1',
        [ok.rows![0]!.id],
      );
      expect(a.rows[0]!.w).toEqual(['REST_RULE', 'WEEKLY_HOURS_CAP']);
      // a hard rule is never waved through
      const clash = await shift(c, monday, 0, '16:00', 4);
      const r = await attemptAs(c, OLIVIA(), 'select hr.assign($1, $2, $3)', [
        clash,
        sam,
        '{REST_RULE,WEEKLY_HOURS_CAP,SHIFT_OVERLAP}',
      ]);
      expect(r.error).toBe('SHIFT_OVERLAP');
    });
  });

  it('LEAVE_CONFLICT: approved leave blocks the dates; pending leave does not', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
      const monday = await futureMonday(c);
      const tenant = await tenantOf(c, ids);
      const type = (
        await c.query<{ id: string }>(
          `insert into hr.leave_type (tenant_id, code, name, annual_days)
           values ($1, 'ZZ_TEST', 'Test', 10) returning id`,
          [tenant],
        )
      ).rows[0]!.id;
      const leave = async (status: string, day: number) =>
        c.query(
          `insert into hr.leave_request (tenant_id, worker_id, owner_user_id, org_node_id,
                                         leave_type_id, from_date, to_date, days, status)
           values ($1, $2, $3, $4, $5, $6::date + $7::int, $6::date + $7::int, 1, $8)`,
          [
            tenant,
            sam,
            ids.user('test.server.3.0'),
            ids.node('TEST-BAR-3.0-FLOOR-SERVICE'),
            type,
            monday,
            day,
            status,
          ],
        );
      await leave('approved', 2);
      await leave('submitted', 3);
      expect((await assign(c, await shift(c, monday, 2, '09:00', 8), sam)).error).toBe(
        'LEAVE_CONFLICT',
      );
      // an overnight shift from the day before that runs into the leave day is blocked too
      expect((await assign(c, await shift(c, monday, 1, '22:00', 6), sam)).error).toBe(
        'LEAVE_CONFLICT',
      );
      expect((await assign(c, await shift(c, monday, 3, '09:00', 8), sam)).error).toBeUndefined();
    });
  });

  it('SHIFT_FULL, and assigning twice returns the same assignment', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
      const pat = await newWorker(c, ids, 'Pat Server', 'TEST-BAR-3.0-FLOOR-SERVICE', 'SERVER');
      const monday = await futureMonday(c);
      const s = await shift(c, monday, 0, '09:00', 8);
      const first = await assign(c, s, sam);
      const again = await assign(c, s, sam);
      expect(again.rows![0]!.id).toBe(first.rows![0]!.id);
      expect((await assign(c, s, pat.workerId)).error).toBe('SHIFT_FULL');
    });
  });

  it('staff cannot assign', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
      const monday = await futureMonday(c);
      const s = await shift(c, monday, 0, '09:00', 8);
      expect((await assign(c, s, sam, ids.user('test.server.3.0'))).error).toBe('NOT_AUTHORISED');
      const direct = await attemptAs(
        c,
        ids.user('test.bar-manager.3.0'),
        `insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id,
                                          org_node_id, start_at, end_at)
         select tenant_id, id, $2, $3, org_node_id, start_at, end_at from hr.shift where id = $1`,
        [s, sam, ids.user('test.server.3.0')],
      );
      expect(direct.error).toMatch(/permission denied/);
    });
  });
});

describe('candidates, publish and notifications', () => {
  it('lists candidates with the rule each would break', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
      const pat = await newWorker(c, ids, 'Pat Server', 'TEST-BAR-3.0-FLOOR-SERVICE', 'SERVER');
      await workerFor(c, ids, 'test.cook.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE', 'COOK');
      const monday = await futureMonday(c);
      await assign(c, await shift(c, monday, 0, '09:00', 8), sam);
      const target = await shift(c, monday, 0, '20:00', 4, 'SERVER', { headcount: 2 });
      const r = await attemptAs<{
        worker_id: string;
        violation: string | null;
        warnings: { code: string; detail: string }[];
        week_hours: string;
      }>(
        c,
        OLIVIA(),
        'select worker_id, violation, warnings, week_hours from hr.assign_candidates($1)',
        [target],
      );
      // other seeded servers may be listed too; these two show both outcomes. Rest is a
      // warning (ADR 019): Sam can still be assigned, after acknowledging it
      expect(r.rows!.filter((x) => [pat.workerId, sam].includes(x.worker_id))).toEqual([
        { worker_id: pat.workerId, violation: null, warnings: [], week_hours: '0.0' },
        {
          worker_id: sam,
          violation: null,
          warnings: [
            { code: 'REST_RULE', detail: 'would have 3 h rest between shifts (needs 10 h)' },
          ],
          week_hours: '8.0',
        },
      ]);
      // candidates without warnings come first
      expect(r.rows!.findIndex((x) => x.warnings.length > 0)).toBeGreaterThan(
        r.rows!.findLastIndex((x) => x.violation === null && x.warnings.length === 0),
      );
    });
  });

  it('publish flips the week to published and notifies each assigned worker once', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const sam = await workerFor(
        c,
        ids,
        'test.server.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'SERVER',
      );
      const monday = await futureMonday(c);
      const a = await shift(c, monday, 0, '09:00', 8);
      const b = await shift(c, monday, 1, '09:00', 8);
      await shift(c, monday, 2, '09:00', 8); // unassigned, still published
      await assign(c, a, sam);
      await assign(c, b, sam);
      // not published yet: no notification
      const before = await attemptAs(
        c,
        ids.user('test.server.3.0'),
        'select * from ops.notification',
      );
      expect(before.rows!.length).toBe(0);

      const pub = await attemptAs<{ n: number }>(
        c,
        OLIVIA(),
        'select hr.publish_week($1, $2) as n',
        [ids.node('TEST-BAR-3.0-FLOOR-SERVICE'), monday],
      );
      expect(pub.rows![0]!.n).toBe(3);
      const notes = await attemptAs<{ kind: string; link: string }>(
        c,
        ids.user('test.server.3.0'),
        'select kind, link from ops.notification',
      );
      expect(notes.rows).toEqual([{ kind: 'roster_published', link: '/roster/my' }]);

      // edits after publish notify the affected worker
      const asg = await c.query<{ id: string }>(
        `select id from hr.shift_assignment where shift_id = $1 and status = 'assigned'`,
        [b],
      );
      await attemptAs(c, OLIVIA(), 'select hr.unassign($1)', [asg.rows[0]!.id]);
      const after = await attemptAs<{ kind: string }>(
        c,
        ids.user('test.server.3.0'),
        'select kind from ops.notification order by created_at, id',
      );
      expect(after.rows!.map((r) => r.kind)).toEqual(['roster_published', 'roster_changed']);

      // My shifts: Sam reads his own assignments through RLS
      const mine = await attemptAs<{ shift_id: string }>(
        c,
        ids.user('test.server.3.0'),
        `select a.shift_id from hr.shift_assignment a join hr.shift s on s.id = a.shift_id
          where a.owner_user_id = core.current_user_id() and a.status = 'assigned'`,
      );
      expect(mine.rows!.map((r) => r.shift_id)).toEqual([a]);
    });
  });
});
