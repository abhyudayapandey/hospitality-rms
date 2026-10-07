import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Who answers for a regular job and who does it (ADR 073). A calendar job's owner role is
// accountable; its optional doer role gets the To do item and marks it done, and the
// accountable people are told when it is due and when it is done. Whoever has a compliance
// To do item (or keeps Compliance there) may hand it to one person who works at that place.
// Test Company's Hotel 1.0: the lift rescue drill sits in Engineering; the GM answers for it
// here, the Chief Engineer does it, the Technician works there too.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const GM = 'test.general-manager.1.0';
const CE = 'test.chief-engineer.1.0';
const TECH = 'test.technician.1.0';
const ENG = 'TEST-HOTEL-1.0-ENGINEERING';

const jobId = async (c: pg.PoolClient, name: string) =>
  (
    await c.query<{ id: string }>(
      `select id from ops.compliance_item where name = $1 and archived_at is null`,
      [name],
    )
  ).rows[0]!.id;

/** The GM makes the lift drill theirs to answer for, done by the Chief Engineer, due in 5 days. */
async function drillForGm(c: pg.PoolClient, doer: string | null = 'CHIEF_ENGINEER') {
  const lift = await jobId(c, 'Lift rescue drill');
  const r = await attemptAs<{ id: string }>(
    c,
    ids.user(GM),
    `select ops.save_compliance_item($1, $2, 'Lift rescue drill', 3, current_date + 5,
                                     'GENERAL_MANAGER', false, $3) as id`,
    [lift, ids.node(ENG), doer],
  );
  expect(r.error).toBeUndefined();
  return lift;
}

const openTask = async (c: pg.PoolClient, job: string) =>
  (
    await c.query<{ id: string; job_role_code: string; assignee_user_id: string | null }>(
      `select id, job_role_code, assignee_user_id from ops.task
        where compliance_item_id = $1 and status in ('open', 'in_progress')`,
      [job],
    )
  ).rows;

/** The notices of one kind a person has about the lift drill. */
const notes = async (c: pg.PoolClient, who: string, kind: string) =>
  (
    await c.query<{ title: string }>(
      `select title from ops.notification
        where owner_user_id = $1 and kind = $2 and title like '%Lift rescue drill%'
        order by created_at`,
      [ids.user(who), kind],
    )
  ).rows.map((r) => r.title);

describe('accountable and who does it', () => {
  it('the To do goes to who does it; the accountable people are told it is due', async () => {
    await inRolledBackTx(async (c) => {
      const lift = await drillForGm(c);
      await c.query(`select * from ops.compliance_tick()`);
      expect((await openTask(c, lift)).map((t) => t.job_role_code)).toEqual(['CHIEF_ENGINEER']);
      expect(await notes(c, CE, 'compliance_due')).toHaveLength(1);
      const gm = await notes(c, GM, 'compliance_due');
      expect(gm).toHaveLength(1);
      expect(gm[0]).toMatch(/Lift rescue drill/);
      expect(gm[0]).toMatch(/Chief Engineer/);
      // the screen says both
      const row = await attemptAs<{ owner_role_name: string; doer_role_name: string | null }>(
        c,
        ids.user(GM),
        `select owner_role_name, doer_role_name from ops.compliance_items(null) where id = $1`,
        [lift],
      );
      expect(row.rows).toEqual([
        { owner_role_name: 'General Manager', doer_role_name: 'Chief Engineer' },
      ]);
    });
  });

  it('an open reminder follows a change of who does it; the same role as accountable is stored as none', async () => {
    await inRolledBackTx(async (c) => {
      const lift = await drillForGm(c);
      await c.query(`select * from ops.compliance_tick()`);
      await drillForGm(c, null);
      expect((await openTask(c, lift)).map((t) => t.job_role_code)).toEqual(['GENERAL_MANAGER']);
      await drillForGm(c, 'GENERAL_MANAGER');
      const d = await c.query<{ doer_role: string | null }>(
        `select doer_role from ops.compliance_item where id = $1`,
        [lift],
      );
      expect(d.rows[0]!.doer_role).toBeNull();
    });
  });

  it('who does it must work at the place; accountable is checked at the outlet', async () => {
    await inRolledBackTx(async (c) => {
      const lift = await jobId(c, 'Lift rescue drill');
      const save = (owner: string, doer: string | null) =>
        attemptAs(
          c,
          ids.user(GM),
          `select ops.save_compliance_item($1, $2, 'Lift rescue drill', 3, current_date + 5,
                                           $3, false, $4)`,
          [lift, ids.node(ENG), owner, doer],
        );
      // nobody in the bar manager role works in Hotel 1.0's engineering
      expect((await save('GENERAL_MANAGER', 'BAR_MANAGER')).error).toMatch(/INVALID_ASSIGNEE/);
      // the GM works at the hotel, not in engineering: fine to answer for it
      expect((await save('GENERAL_MANAGER', 'CHIEF_ENGINEER')).error).toBeUndefined();
      // but not to do it there
      expect((await save('CHIEF_ENGINEER', 'GENERAL_MANAGER')).error).toMatch(/INVALID_ASSIGNEE/);
    });
  });

  it('when it is done, the accountable people are told who did it', async () => {
    await inRolledBackTx(async (c) => {
      const lift = await drillForGm(c);
      await c.query(`select * from ops.compliance_tick()`);
      const done = await attemptAs(
        c,
        ids.user(CE),
        `select ops.mark_compliance_done($1, current_date, '{}', 'all clear')`,
        [lift],
      );
      expect(done.error).toBeUndefined();
      const gm = await notes(c, GM, 'compliance_done');
      expect(gm).toHaveLength(1);
      expect(gm[0]).toMatch(/Lift rescue drill/);
      // the one who did it isn't told about their own work
      expect(await notes(c, CE, 'compliance_done')).toEqual([]);
    });
  });
});

describe('handing a compliance To do on', () => {
  it('who has it gives it to someone at the place, who then does it', async () => {
    await inRolledBackTx(async (c) => {
      const lift = await drillForGm(c);
      await c.query(`select * from ops.compliance_tick()`);
      const task = (await openTask(c, lift))[0]!.id;
      const people = await attemptAs<{ user_id: string }>(
        c,
        ids.user(CE),
        `select user_id from ops.hand_on_people($1)`,
        [task],
      );
      expect(people.rows!.map((p) => p.user_id)).toContain(ids.user(TECH));
      const can = await attemptAs<{ can_hand_on: boolean }>(
        c,
        ids.user(CE),
        `select can_hand_on from ops.compliance_task($1)`,
        [task],
      );
      expect(can.rows).toEqual([{ can_hand_on: true }]);
      const r = await attemptAs(c, ids.user(CE), `select ops.reassign_task($1, $2)`, [
        task,
        ids.user(TECH),
      ]);
      expect(r.error).toBeUndefined();
      expect((await openTask(c, lift))[0]!.assignee_user_id).toBe(ids.user(TECH));
      expect(await notes(c, TECH, 'task_assigned')).toHaveLength(1);
      const done = await attemptAs(
        c,
        ids.user(TECH),
        `select ops.mark_compliance_done($1, current_date, '{}', null)`,
        [lift],
      );
      expect(done.error).toBeUndefined();
      expect(await notes(c, GM, 'compliance_done')).toHaveLength(1);
    });
  });

  it('the accountable keeper may hand it on too; nobody else may, and only to someone there', async () => {
    await inRolledBackTx(async (c) => {
      const lift = await drillForGm(c);
      await c.query(`select * from ops.compliance_tick()`);
      const task = (await openTask(c, lift))[0]!.id;
      const give = (who: string, to: string) =>
        attemptAs(c, ids.user(who), `select ops.reassign_task($1, $2)`, [task, ids.user(to)]);
      // a cook at the hotel: not theirs, and they don't keep Compliance
      expect((await give('test.commis.1.0', TECH)).error).toMatch(/NOT_AUTHORISED/);
      expect(
        (
          await attemptAs(c, ids.user('test.commis.1.0'), `select * from ops.hand_on_people($1)`, [
            task,
          ])
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
      // not to someone at another outlet
      expect((await give(GM, 'test.bar-manager.3.0')).error).toMatch(/INVALID_ASSIGNEE/);
      // the GM keeps Compliance at the hotel
      expect((await give(GM, TECH)).error).toBeUndefined();
      // a done task isn't handed on
      await c.query(`update ops.task set status = 'done' where id = $1`, [task]);
      expect((await give(GM, CE)).error).toMatch(/INVALID_STATE/);
    });
  });

  it('a licence renewal can be handed on the same way', async () => {
    await inRolledBackTx(async (c) => {
      // the seed's tick put the expired FSSAI licence's renewal on the GM's list
      const t = await c.query<{ id: string }>(
        `select t.id from ops.task t join ops.licence l on l.id = t.licence_id
          where l.name = 'FSSAI licence' and l.org_node_id = $1
            and t.status in ('open', 'in_progress')`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      expect(t.rows).toHaveLength(1);
      const r = await attemptAs(c, ids.user(GM), `select ops.reassign_task($1, $2)`, [
        t.rows[0]!.id,
        ids.user('test.assistant-general-manager.1.0'),
      ]);
      expect(r.error).toBeUndefined();
      const can = await attemptAs<{ can_act: boolean }>(
        c,
        ids.user('test.assistant-general-manager.1.0'),
        `select can_act from ops.compliance_task($1)`,
        [t.rows[0]!.id],
      );
      expect(can.rows).toEqual([{ can_act: true }]);
    });
  });
});

describe('Needs action', () => {
  it('its count is the licences within 90 days and the jobs within 14, for every viewer', async () => {
    await inRolledBackTx(async (c) => {
      await drillForGm(c);
      for (const who of [GM, 'test.area-manager', 'test.account-owner', CE]) {
        const r = await attemptAs<{ ok: boolean }>(
          c,
          ids.user(who),
          `select (select needs_action from ops.compliance_counts(null))
                    = (select count(*) from ops.licences(null) where days_left <= 90)
                    + (select count(*) from ops.compliance_items(null) where days_left <= 14)
                  as ok`,
        );
        expect(r.error, who).toBeUndefined();
        expect(r.rows![0]!.ok, who).toBe(true);
      }
      const gm = await attemptAs<{ needs_action: number }>(
        c,
        ids.user(GM),
        `select needs_action from ops.compliance_counts(null)`,
      );
      // the expired FSSAI licence, the overdue pest control, the lift drill due in 5 days
      expect(gm.rows![0]!.needs_action).toBe(3);
    });
  });
});
