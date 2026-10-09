import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  type SeedIds,
} from '../test/helpers';

// Checklists, part 1 (ADR 087): a second signature, monthly and nth-weekday schedules, and
// steps that run only on some weekdays.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN';
const IST = 'Asia/Kolkata';

async function occurrences(c: PoolClient, schedule: object, from: string, to: string) {
  const { rows } = await c.query<{ at: Date }>(
    `select o as at from ops.occurrences($1::jsonb, $2, $3::timestamptz, $4::timestamptz) o order by o`,
    [JSON.stringify(schedule), IST, from, to],
  );
  return rows.map((r) =>
    r.at.toLocaleString('sv-SE', { timeZone: IST, hour12: false }).slice(0, 16),
  );
}

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

async function tick(c: PoolClient, now: string) {
  await actAs(c, 'wf_executor', null);
  await c.query('select * from ops.tasks_tick($1::timestamptz)', [now]);
  await resetRole(c);
}

/** A checklist for the kitchen's commis, with its sign-off rule set as file 29 sets it. */
async function template(
  c: PoolClient,
  signOff: string,
  steps: object[] = [
    { label: 'Walk-in', kind: 'number', min: 0, max: 5, unit: '°C' },
    { label: 'Doors closed', kind: 'tick' },
  ],
  schedule: object = { kind: 'daily', times: ['07:00'] },
) {
  const [row] = await run<{ id: string }>(
    c,
    'test.executive-chef.1.0',
    `select ops.save_template(null, $1, 'Signed checklist', $2::jsonb, $3::jsonb, $4::jsonb) as id`,
    [
      ids.node(KITCHEN),
      JSON.stringify(schedule),
      JSON.stringify({ mode: 'job_role', role: 'COMMIS' }),
      JSON.stringify(steps),
    ],
  );
  await c.query(`update ops.checklist_template set sign_off = $2 where id = $1`, [
    row!.id,
    signOff,
  ]);
  return row!.id;
}

/** Makes the template's round due on 5 Oct 2026 (a Monday) at 07:00 and returns it. */
async function round(c: PoolClient, tpl: string) {
  await tick(c, '2026-10-05T06:00:00+05:30');
  const { rows } = await c.query<{ id: string }>(
    `select id from ops.task where template_id = $1 order by due_at limit 1`,
    [tpl],
  );
  return rows[0]!.id;
}

async function finish(c: PoolClient, who: string, task: string) {
  const steps = await c.query<{ id: string; kind: string }>(
    `select id, kind from ops.task_step where task_id = $1 order by position`,
    [task],
  );
  for (const s of steps.rows) {
    await run(c, who, `select ops.complete_step($1, $2, $3::jsonb)`, [
      task,
      s.id,
      JSON.stringify(s.kind === 'number' ? { number: 3 } : { done: true }),
    ]);
  }
  await run(c, who, `select ops.complete_task($1, null)`, [task]);
}

async function signOffTask(c: PoolClient, checklist: string) {
  const { rows } = await c.query<{ id: string; assignee: string; status: string }>(
    `select t.id, u.username as assignee, t.status
       from ops.task t join core.app_user u on u.id = t.assignee_user_id
      where t.signs_off = $1 order by t.created_at desc`,
    [checklist],
  );
  return rows;
}

describe('schedules', () => {
  it('monthly on days of the month; a day past the end falls on the last day', async () => {
    await inRolledBackTx(async (c) => {
      const got = await occurrences(
        c,
        { kind: 'monthly', days: [1, 16, 31], times: ['09:00'] },
        '2026-10-01T00:00:00+05:30',
        '2026-11-30T23:59:00+05:30',
      );
      expect(got).toEqual([
        '2026-10-01 09:00',
        '2026-10-16 09:00',
        '2026-10-31 09:00',
        '2026-11-01 09:00',
        '2026-11-16 09:00',
        '2026-11-30 09:00',
      ]);
    });
  });

  it('the 1st and 3rd Monday', async () => {
    await inRolledBackTx(async (c) => {
      const got = await occurrences(
        c,
        { kind: 'nth_weekday', weekday: 1, nths: [1, 3], times: ['10:00'] },
        '2026-10-01T00:00:00+05:30',
        '2026-11-30T23:59:00+05:30',
      );
      expect(got).toEqual([
        '2026-10-05 10:00',
        '2026-10-19 10:00',
        '2026-11-02 10:00',
        '2026-11-16 10:00',
      ]);
    });
  });

  it('refuses what it cannot read', async () => {
    await inRolledBackTx(async (c) => {
      for (const bad of [
        { kind: 'monthly', days: [], times: ['09:00'] },
        { kind: 'monthly', days: [32], times: ['09:00'] },
        { kind: 'monthly', days: [1.5], times: ['09:00'] },
        { kind: 'monthly', days: [1], times: ['9am'] },
        { kind: 'nth_weekday', weekday: 8, nths: [1], times: ['09:00'] },
        { kind: 'nth_weekday', weekday: 1, nths: [5], times: ['09:00'] },
      ]) {
        await c.query('savepoint s');
        await expect(
          c.query(`select ops.check_schedule($1::jsonb)`, [JSON.stringify(bad)]),
          JSON.stringify(bad),
        ).rejects.toThrow(/INVALID_SCHEDULE/);
        await c.query('rollback to savepoint s');
      }
      await c.query('savepoint s');
      await expect(
        c.query(`select ops.check_steps($1::jsonb)`, [
          JSON.stringify([{ label: 'Hoods', kind: 'tick', days: [0] }]),
        ]),
      ).rejects.toThrow(/INVALID_STEPS/);
      await c.query('rollback to savepoint s');
    });
  });

  it('a step with days runs only on them; a day with none of its steps has no round', async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(
        c,
        'none',
        [
          { label: 'Hoods', kind: 'tick', days: [1] },
          { label: 'Fridge seals', kind: 'tick', days: [1, 4] },
        ],
        { kind: 'daily', times: ['07:00'] },
      );
      // Monday 5 Oct to Thursday 8 Oct 2026
      for (const day of ['05', '06', '07', '08']) {
        await tick(c, `2026-10-${day}T06:00:00+05:30`);
      }
      const { rows } = await c.query<{ day: string; steps: string }>(
        `select to_char(t.due_at at time zone 'Asia/Kolkata', 'DD') as day,
                string_agg(s.label, ', ' order by s.position) as steps
           from ops.task t join ops.task_step s on s.task_id = t.id
          where t.template_id = $1 group by 1 order by 1`,
        [tpl],
      );
      expect(rows).toEqual([
        { day: '05', steps: 'Hoods, Fridge seals' },
        { day: '08', steps: 'Fridge seals' },
      ]);
      // the positions are 1, 2, ... whatever was left out
      const pos = await c.query<{ p: number[] }>(
        `select array_agg(s.position order by s.position) as p from ops.task t
           join ops.task_step s on s.task_id = t.id
          where t.template_id = $1 and t.due_at = '2026-10-08T07:00:00+05:30'`,
        [tpl],
      );
      expect(pos.rows[0]!.p).toEqual([1]);
    });
  });
});

describe('sign-off', () => {
  it("goes one level up: the commis's round goes to the sous chef, who signs it off", async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(c, 'up');
      const task = await round(c, tpl);
      await finish(c, 'test.commis.1.0', task);
      const [s] = await signOffTask(c, task);
      expect(s).toMatchObject({ assignee: 'test.sous-chef.1.0', status: 'open' });
      // it is on their To do list, and the commis is told nothing yet
      const mine = await run<{ id: string; kind: string }>(
        c,
        'test.sous-chef.1.0',
        `select id, kind from ops.my_tasks() where id = $1`,
        [s!.id],
      );
      expect(mine).toEqual([{ id: s!.id, kind: 'sign_off' }]);
      // they see the round's steps, with who did each
      const [d] = await run<{ t: { steps: { done_by_name: string }[]; signs_off_title: string } }>(
        c,
        'test.sous-chef.1.0',
        `select ops.task_detail($1) as t`,
        [s!.id],
      );
      expect(d!.t.signs_off_title).toBe('Signed checklist');
      expect(d!.t.steps).toHaveLength(2);
      expect(d!.t.steps.every((x) => x.done_by_name)).toBe(true);

      await run(c, 'test.sous-chef.1.0', `select ops.sign_off($1)`, [s!.id]);
      const after = await c.query<{ signed: string; checked: number; status: string }>(
        `select u.username as signed, t.status,
                (select count(*)::int from ops.task_step x
                  where x.task_id = t.id and x.checked_by = t.signed_off_by) as checked
           from ops.task t join core.app_user u on u.id = t.signed_off_by where t.id = $1`,
        [task],
      );
      expect(after.rows[0]).toEqual({ signed: 'test.sous-chef.1.0', status: 'done', checked: 2 });
      expect((await signOffTask(c, task))[0]!.status).toBe('done');
    });
  });

  it('sent back with a note: the steps open again for the doer, and a new sign-off follows', async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(c, 'up');
      const task = await round(c, tpl);
      await finish(c, 'test.commis.1.0', task);
      const [s] = await signOffTask(c, task);
      const empty = await attemptAs(
        c,
        ids.user('test.sous-chef.1.0'),
        `select ops.send_back($1, ' ')`,
        [s!.id],
      );
      expect(empty.error).toMatch(/INVALID_VALUE/);
      await run(c, 'test.sous-chef.1.0', `select ops.send_back($1, 'Walk-in reading again')`, [
        s!.id,
      ]);
      const back = await c.query<{ status: string; who: string; note: string; open: number }>(
        `select t.status, u.username as who, t.sent_back_note as note,
                (select count(*)::int from ops.task_step x where x.task_id = t.id and x.done_at is null) as open
           from ops.task t join core.app_user u on u.id = t.assignee_user_id where t.id = $1`,
        [task],
      );
      expect(back.rows[0]).toEqual({
        status: 'in_progress',
        who: 'test.commis.1.0',
        note: 'Walk-in reading again',
        open: 2,
      });
      const told = await c.query<{ title: string }>(
        `select title from ops.notification where owner_user_id = $1 and title like 'Sent back:%'`,
        [ids.user('test.commis.1.0')],
      );
      expect(told.rows.map((r) => r.title)).toEqual(['Sent back: Signed checklist']);

      await finish(c, 'test.commis.1.0', task);
      const all = await signOffTask(c, task);
      expect(all.map((x) => [x.assignee, x.status])).toEqual([
        ['test.sous-chef.1.0', 'open'],
        ['test.sous-chef.1.0', 'done'],
      ]);
    });
  });

  it('whoever did any of it never signs it off', async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(c, 'up');
      const task = await round(c, tpl);
      await finish(c, 'test.commis.1.0', task);
      const [s] = await signOffTask(c, task);
      // given to the commis who did it (a head may hand a task on)
      await c.query(`update ops.task set assignee_user_id = $2 where id = $1`, [
        s!.id,
        ids.user('test.commis.1.0'),
      ]);
      for (const fn of ['ops.sign_off($1)', `ops.send_back($1, 'again')`]) {
        const r = await attemptAs(c, ids.user('test.commis.1.0'), `select ${fn}`, [s!.id]);
        expect(r.error, fn).toMatch(/OWN_WORK/);
      }
      // nor is a sign-off finished like other tasks
      await c.query(`update ops.task set assignee_user_id = $2 where id = $1`, [
        s!.id,
        ids.user('test.sous-chef.1.0'),
      ]);
      const plain = await attemptAs(
        c,
        ids.user('test.sous-chef.1.0'),
        `select ops.complete_task($1, null)`,
        [s!.id],
      );
      expect(plain.error).toMatch(/INVALID_STATE/);
    });
  });

  it('only its signer works on it; nobody at another customer even finds it', async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(c, 'up');
      const task = await round(c, tpl);
      await finish(c, 'test.commis.1.0', task);
      const [s] = await signOffTask(c, task);
      const other = await attemptAs(c, ids.user('test.commis-b.1.0'), `select ops.sign_off($1)`, [
        s!.id,
      ]);
      expect(other.error).toMatch(/NOT_AUTHORISED/);
      const solo = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        `select ops.sign_off($1)`,
        [s!.id],
      );
      expect(solo.error).toMatch(/NOT_FOUND/);
      const look = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        `select ops.task_detail($1)`,
        [s!.id],
      );
      expect(look.error).toMatch(/NOT_FOUND/);
    });
  });

  it('by rule: the department head, a named role, or nobody', async () => {
    await inRolledBackTx(async (c) => {
      const head = await round(c, await template(c, 'department_head'));
      await finish(c, 'test.commis.1.0', head);
      expect((await signOffTask(c, head))[0]!.assignee).toBe('test.executive-chef.1.0');

      // the round on another day, so the two templates' rounds don't share a due time
      const role = await round(c, await template(c, 'role:CHEF_DE_PARTIE'));
      await finish(c, 'test.commis.1.0', role);
      expect((await signOffTask(c, role))[0]!.assignee).toBe('test.chef-de-partie.1.0');

      const none = await round(c, await template(c, 'none'));
      await finish(c, 'test.commis.1.0', none);
      expect(await signOffTask(c, none)).toEqual([]);
    });
  });

  it('refuses a rule it cannot read', async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(c, 'none');
      await c.query('savepoint s');
      await expect(
        c.query(`update ops.checklist_template set sign_off = 'boss' where id = $1`, [tpl]),
      ).rejects.toThrow(/check/);
      await c.query('rollback to savepoint s');
    });
  });
});
