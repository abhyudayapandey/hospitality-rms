import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The compliance pack (ADR 069). Compliance is a bundle out of every plan unless the platform
// admin puts it in: Test Company has it (seed/dev/002), Test Solo Bar Co. doesn't. Test
// Company's files 38 and 39: Hotel 1.0's FSSAI licence expired on 31 Jan 2026 and its Fire NOC
// runs to 2030, Bar 3.0's excise licence to 2031; Hotel 1.0's pest control service was due on
// 15 Jan 2026 (overdue), its duct cleaning and lift rescue drill not until 2030.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const GM = 'test.general-manager.1.0';
const H10 = 'TEST-HOTEL-1.0';

const names = async (c: pg.PoolClient, who: string, fn: string, node: string | null = null) => {
  const r = await attemptAs<{ name: string }>(
    c,
    ids.user(who),
    `select name from ${fn}($1) order by name`,
    [node ? ids.node(node) : null],
  );
  expect(r.error, who).toBeUndefined();
  return r.rows!.map((x) => x.name);
};

const doc = (c: pg.PoolClient, outlet: string) =>
  c
    .query<{ t: string }>(`select tenant_id::text t from core.hierarchy_node where id = $1`, [
      ids.node(outlet),
    ])
    .then((r) => `compliance/${r.rows[0]!.t}/${ids.node(outlet)}/${crypto.randomUUID()}.pdf`);

const licenceId = async (c: pg.PoolClient, name: string, outlet = H10) =>
  (
    await c.query<{ id: string }>(
      `select id from ops.licence where org_node_id = $1 and name = $2 and archived_at is null`,
      [ids.node(outlet), name],
    )
  ).rows[0]!.id;

const jobId = async (c: pg.PoolClient, name: string) =>
  (
    await c.query<{ id: string }>(
      `select id from ops.compliance_item where name = $1 and archived_at is null`,
      [name],
    )
  ).rows[0]!.id;

describe('the plan', () => {
  it('Compliance is out unless put in: Test Company has it, the Solo Bar does not', async () => {
    await inRolledBackTx(async (c) => {
      const on = await c.query<{ company: boolean; solo: boolean; d: boolean; other: boolean }>(
        `select core.module_on($1, 'compliance') company, core.module_on($2, 'compliance') solo,
                core.bundle_default('compliance') d, core.bundle_default('tasks_food_safety') other`,
        [ids.tenant(), ids.tenant('TEST-SOLO-COMPANY')],
      );
      expect(on.rows[0]).toEqual({ company: true, solo: false, d: false, other: true });
      // the owner can't switch it on outside the plan
      const r = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        `select core.set_module('compliance', true)`,
      );
      expect(r.error).toMatch(/NOT_IN_PLAN/);
      // and nothing of it shows or saves there
      expect(await names(c, 'test.solo.bar-manager', 'ops.licences')).toEqual([]);
      const save = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        `select ops.save_licence(null, $1, 'FSSAI', 'FSSAI licence', '1', 'FSSAI', null, null,
                                 'BAR_MANAGER', '{}')`,
        [ids.node('TEST-SOLO-BAR')],
      );
      expect(save.error).toMatch(/MODULE_OFF/);
    });
  });
});

describe('who sees and keeps it', () => {
  it("the GM keeps their outlet's; the area manager and the owner see every outlet; staff nothing", async () => {
    await inRolledBackTx(async (c) => {
      expect(await names(c, GM, 'ops.licences')).toEqual(['Fire NOC', 'FSSAI licence']);
      expect(await names(c, 'test.account-owner', 'ops.licences')).toEqual([
        'Excise bar licence',
        'Fire NOC',
        'FSSAI licence',
      ]);
      expect(await names(c, 'test.commis.1.0', 'ops.licences')).toEqual([]);
      expect(await names(c, GM, 'ops.compliance_items')).toEqual([
        'Kitchen exhaust duct cleaning',
        'Lift rescue drill',
        'Pest control service',
      ]);
      // the owner reads, never changes
      const r = await attemptAs(
        c,
        ids.user('test.account-owner'),
        `select ops.save_licence(null, $1, 'OTHER', 'Signage', null, null, null, null,
                                 'GENERAL_MANAGER', '{}')`,
        [ids.node(H10)],
      );
      expect(r.error).toMatch(/NOT_AUTHORISED/);
      for (const who of ['test.commis.1.0', 'test.general-manager.1.1']) {
        const x = await attemptAs(
          c,
          ids.user(who),
          `select ops.save_licence(null, $1, 'OTHER', 'Signage', null, null, null, null,
                                   'GENERAL_MANAGER', '{}')`,
          [ids.node(H10)],
        );
        expect(x.error, who).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('each tab and Home count equals its list, for every kind of viewer', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [GM, 'test.account-owner', 'test.area-manager', 'test.commis.1.0']) {
        const r = await attemptAs<{ ok: boolean }>(
          c,
          ids.user(who),
          `select (select licences from ops.compliance_counts(null))
                    = (select count(*) from ops.licences(null))
              and (select expiring from ops.compliance_counts(null))
                    = (select count(*) from ops.licences(null) where days_left <= 90)
              and (select items from ops.compliance_counts(null))
                    = (select count(*) from ops.compliance_items(null))
              and (select overdue from ops.compliance_counts(null))
                    = (select count(*) from ops.compliance_items(null) where days_left < 0)
                as ok`,
        );
        expect(r.rows?.[0]?.ok, who).toBe(true);
      }
      const gm = await attemptAs<{ expiring: number; overdue: number }>(
        c,
        ids.user(GM),
        `select expiring, overdue from ops.compliance_counts(null)`,
      );
      expect(gm.rows![0]).toEqual({ expiring: 1, overdue: 1 });
    });
  });
});

describe('licences', () => {
  it('a renewal is a new licence; the old one stays as history and its reminder is done', async () => {
    await inRolledBackTx(async (c) => {
      const old = await licenceId(c, 'FSSAI licence');
      // the seed's tasks job made its renewal reminder (it has expired)
      const task = await c.query<{ id: string; job_role_code: string }>(
        `select id, job_role_code from ops.task where licence_id = $1 and status = 'open'`,
        [old],
      );
      expect(task.rows.map((t) => t.job_role_code)).toEqual(['GENERAL_MANAGER']);
      // a renewal needs the renewed licence, and a later expiry
      const none = await attemptAs(
        c,
        ids.user(GM),
        `select ops.renew_licence($1, null, '2026-02-01', '2031-01-31', '{}')`,
        [old],
      );
      expect(none.error).toMatch(/DOCUMENT_NEEDED/);
      const file = await doc(c, H10);
      const early = await attemptAs(
        c,
        ids.user(GM),
        `select ops.renew_licence($1, null, '2020-01-01', '2025-01-31', $2)`,
        [old, [file]],
      );
      expect(early.error).toMatch(/INVALID_DATES/);
      const elsewhere = await attemptAs(
        c,
        ids.user(GM),
        `select ops.renew_licence($1, null, '2026-02-01', '2031-01-31', $2)`,
        [old, [await doc(c, 'TEST-BAR-3.0')]],
      );
      expect(elsewhere.error).toMatch(/INVALID_FILE/);
      const r = await attemptAs<{ id: string }>(
        c,
        ids.user(GM),
        `select ops.renew_licence($1, 'FSSAI/2026/9', '2026-02-01', '2031-01-31', $2) as id`,
        [old, [file]],
      );
      expect(r.error).toBeUndefined();
      const history = await attemptAs<{ number: string; archive_reason: string | null }>(
        c,
        ids.user(GM),
        `select number, archive_reason from ops.licence_history($1)`,
        [r.rows![0]!.id],
      );
      expect(history.rows).toEqual([
        { number: 'FSSAI/2026/9', archive_reason: null },
        { number: '11521999000123', archive_reason: 'renewed' },
      ]);
      const after = await c.query<{ status: string }>(`select status from ops.task where id = $1`, [
        task.rows[0]!.id,
      ]);
      expect(after.rows[0]!.status).toBe('done');
      // and it no longer counts as expiring
      const gm = await attemptAs<{ expiring: number }>(
        c,
        ids.user(GM),
        `select expiring from ops.compliance_counts(null)`,
      );
      expect(gm.rows![0]!.expiring).toBe(0);
    });
  });

  it('reminders: 90 days before, notices at 30 and 7, each once; only where Compliance is on', async () => {
    await inRolledBackTx(async (c) => {
      const noc = await licenceId(c, 'Fire NOC');
      // the Fire NOC expires 31 May 2030; run the job as if it were later
      const tick = (at: string) =>
        c.query(`select * from ops.compliance_tick($1::timestamptz)`, [at]);
      const tasks = async () =>
        (
          await c.query<{ n: number }>(
            `select count(*)::int n from ops.task where licence_id = $1`,
            [noc],
          )
        ).rows[0]!.n;
      const notes = async () =>
        (
          await c.query<{ title: string }>(
            `select n.title from ops.notification n
              where n.kind = 'licence_expiring' and n.title like '%Fire NOC%' order by n.created_at`,
          )
        ).rows.map((x) => x.title);
      await tick('2030-02-01T06:00:00Z'); // 119 days before: nothing
      expect(await tasks()).toBe(0);
      await tick('2030-03-03T06:00:00Z'); // 89 days before: the To do item, for the engineer
      await tick('2030-03-04T06:00:00Z');
      expect(await tasks()).toBe(1);
      const t = await c.query<{ job_role_code: string; due: string; priority: string }>(
        `select job_role_code, to_char(due_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') due,
                priority from ops.task where licence_id = $1`,
        [noc],
      );
      expect(t.rows[0]).toEqual({
        job_role_code: 'CHIEF_ENGINEER',
        due: '2030-05-31 10:00',
        priority: 'high',
      });
      await tick('2030-05-02T06:00:00Z'); // 29 days
      await tick('2030-05-03T06:00:00Z');
      await tick('2030-05-25T06:00:00Z'); // 6 days
      await tick('2030-05-26T06:00:00Z');
      const n = await notes();
      expect(n.filter((x) => x.startsWith('Licence expires in 89 days')).length).toBeGreaterThan(0);
      expect(n.filter((x) => /in 29 days/.test(x)).length).toBeGreaterThan(0);
      expect(n.filter((x) => /in 6 days/.test(x)).length).toBeGreaterThan(0);
      expect(n.filter((x) => /in (28|5) days/.test(x))).toEqual([]);
      // off the plan, nothing
      await c.query(
        `update core.tenant set settings = jsonb_set(settings, '{bundles}', '{"compliance": false}')
          where id = $1`,
        [ids.tenant()],
      );
      await c.query(`update ops.task set status = 'cancelled' where licence_id = $1`, [noc]);
      await tick('2030-05-27T06:00:00Z');
      expect(
        (
          await c.query<{ n: number }>(
            `select count(*)::int n from ops.task where licence_id = $1 and status = 'open'`,
            [noc],
          )
        ).rows[0]!.n,
      ).toBe(0);
    });
  });
});

describe('the calendar', () => {
  it('whoever the job is with marks it done from their To do item; next due moves on from that day', async () => {
    await inRolledBackTx(async (c) => {
      const lift = await jobId(c, 'Lift rescue drill');
      await c.query(`update ops.compliance_item set next_due = current_date + 5 where id = $1`, [
        lift,
      ]);
      await c.query(`select * from ops.compliance_tick()`);
      const task = await c.query<{ id: string; job_role_code: string }>(
        `select id, job_role_code from ops.task where compliance_item_id = $1 and status = 'open'`,
        [lift],
      );
      expect(task.rows.map((t) => t.job_role_code)).toEqual(['CHIEF_ENGINEER']);
      // the chief engineer doesn't keep the register, but the job is theirs
      expect(await names(c, 'test.chief-engineer.1.0', 'ops.compliance_items')).toEqual([]);
      const about = await attemptAs<{ name: string; can_act: boolean }>(
        c,
        ids.user('test.chief-engineer.1.0'),
        `select name, can_act from ops.compliance_task($1)`,
        [task.rows[0]!.id],
      );
      expect(about.rows).toEqual([{ name: 'Lift rescue drill', can_act: true }]);
      const done = await attemptAs<{ next: string }>(
        c,
        ids.user('test.chief-engineer.1.0'),
        `select ops.mark_compliance_done($1, current_date - 1, '{}', 'all clear')::text as next`,
        [lift],
      );
      expect(done.error).toBeUndefined();
      const want = await c.query<{ d: string }>(
        `select ((current_date - 1) + interval '3 months')::date::text d`,
      );
      expect(done.rows![0]!.next).toBe(want.rows[0]!.d);
      const t = await c.query<{ status: string }>(`select status from ops.task where id = $1`, [
        task.rows[0]!.id,
      ]);
      expect(t.rows[0]!.status).toBe('done');
      // someone else at the outlet can't
      const other = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        `select ops.mark_compliance_done($1, current_date, '{}', null)`,
        [lift],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('a job that needs proof is not done without it; one done in the future is refused', async () => {
    await inRolledBackTx(async (c) => {
      const pest = await jobId(c, 'Pest control service');
      const mark = (files: string[], on = 'current_date') =>
        attemptAs(c, ids.user(GM), `select ops.mark_compliance_done($1, ${on}, $2, null)`, [
          pest,
          files,
        ]);
      expect((await mark([])).error).toMatch(/DOCUMENT_NEEDED/);
      expect((await mark([await doc(c, H10)], 'current_date + 1')).error).toMatch(/INVALID_DATES/);
      expect((await mark([await doc(c, H10)])).error).toBeUndefined();
      const gm = await attemptAs<{ overdue: number }>(
        c,
        ids.user(GM),
        `select overdue from ops.compliance_counts(null)`,
      );
      expect(gm.rows![0]!.overdue).toBe(0);
    });
  });

  it('the Compliance screen lists the outlets where the person sees it', async () => {
    await inRolledBackTx(async (c) => {
      const places = async (who: string) =>
        (
          await attemptAs<{ code: string }>(
            c,
            ids.user(who),
            `select code from core.screen_places('compliance') order by code`,
          )
        ).rows!.map((p) => p.code);
      expect(await places(GM)).toEqual([H10]);
      expect(await places('test.commis.1.0')).toEqual([]);
      expect((await places('test.account-owner')).length).toBeGreaterThan(3);
    });
  });
});
