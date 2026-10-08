import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Done stays in view (ADR 075). A task that is done does not vanish: it stays on the To do
// list of whoever did it, and of everyone its job role (or shift) was given to, under Done,
// saying who did it and when, for that business day and the next; anyone it was for may
// open it. What someone gave to someone else stays under "Given to others", marked done.
// Test Hotel 1.0 has two room attendants, so one sees what the other did.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const HK = 'TEST-HOTEL-1.0-HOUSEKEEPING';
const EH = 'test.executive-housekeeper.1.0';
const HS = 'test.housekeeping-supervisor.1.0';
const RA = 'test.room-attendant.1.0';
const RA_B = 'test.room-attendant-b.1.0';
const RA_OTHER = 'test.room-attendant.1.1'; // the same job role at another hotel
const COMMIS = 'test.commis.1.0'; // works at the hotel, not in housekeeping

async function ok<T extends object>(
  c: pg.PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}
const opens = async (c: pg.PoolClient, who: string, task: string) =>
  (await attemptAs(c, ids.user(who), `select ops.task_detail($1)`, [task])).error === undefined;

type Mine = {
  id: string;
  status: string;
  overdue: boolean;
  completed_at: Date | null;
  done_by_name: string | null;
};
const mine = async (c: pg.PoolClient, who: string, task: string) =>
  (
    await ok<Mine>(
      c,
      who,
      `select id, status, overdue, completed_at, done_by_name from ops.my_tasks() where id = $1`,
      [task],
    )
  )[0];

/** A one-off for the room attendants' job role in housekeeping, due an hour ago. */
async function roleTask(c: pg.PoolClient): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode, job_role_code)
     select tenant_id, id, 'one_off', 'Turn down the suites', now() - interval '1 hour',
            'job_role', 'ROOM_ATTENDANT'
       from core.hierarchy_node where id = $1
     returning id`,
    [ids.node(HK)],
  );
  return r.rows[0]!.id;
}

describe('a done task stays in view', () => {
  it('whoever did it, and the others in its job role, see it under Done: who and when', () =>
    inRolledBackTx(async (c) => {
      const task = await roleTask(c);
      // before: both room attendants have it to do; the other hotel's does not
      expect((await mine(c, RA, task))?.status).toBe('open');
      expect((await mine(c, RA_B, task))?.status).toBe('open');
      expect(await mine(c, RA_OTHER, task)).toBeUndefined();

      await ok(c, RA, `select ops.complete_task($1)`, [task]);

      const own = await mine(c, RA, task);
      expect(own).toMatchObject({ status: 'done', overdue: false });
      expect(own!.completed_at).not.toBeNull();
      const theirs = await mine(c, RA_B, task);
      expect(theirs).toMatchObject({ status: 'done', done_by_name: 'Test Room Attendant 1.0' });
      // and the other one may open it, to see what was done
      expect(await opens(c, RA_B, task)).toBe(true);
      // nobody else gains it
      expect(await mine(c, RA_OTHER, task)).toBeUndefined();
      expect(await opens(c, RA_OTHER, task)).toBe(false);
      expect(await mine(c, COMMIS, task)).toBeUndefined();
      expect(await opens(c, COMMIS, task)).toBe(false);
    }));

  it('stays for the business day it was done and the next, then leaves the list', () =>
    inRolledBackTx(async (c) => {
      const task = await roleTask(c);
      await ok(c, RA, `select ops.complete_task($1)`, [task]);
      const doneOn = (days: number) =>
        c.query(
          `update ops.task set completed_at = rpt.day_start(
                    rpt.business_date(now(), 'Asia/Kolkata') - $2::int, 'Asia/Kolkata')
                    + interval '2 hours'
            where id = $1`,
          [task, days],
        );
      await doneOn(1); // yesterday, as a business day
      expect((await mine(c, RA, task))?.status).toBe('done');
      expect((await mine(c, RA_B, task))?.status).toBe('done');
      await doneOn(2);
      expect(await mine(c, RA, task)).toBeUndefined();
      expect(await mine(c, RA_B, task)).toBeUndefined();
      // it still opens for whoever did it (it was theirs), and Team tasks still lists it
      expect(await opens(c, RA, task)).toBe(true);
    }));

  it('a task given to someone else stays under Given to others, marked done', () =>
    inRolledBackTx(async (c) => {
      const task = await roleTask(c);
      await ok(c, EH, `select ops.reassign_task($1, $2)`, [task, ids.user(HS)]);
      await ok(c, HS, `select ops.complete_task($1)`, [task]);
      const given = await ok<{
        id: string;
        status: string;
        done_by_name: string;
        completed_at: Date | null;
        overdue: boolean;
      }>(
        c,
        EH,
        `select id, status, done_by_name, completed_at, overdue from ops.my_handed_on() where id = $1`,
        [task],
      );
      expect(given).toHaveLength(1);
      expect(given[0]).toMatchObject({
        status: 'done',
        done_by_name: 'Test Housekeeping Supervisor 1.0',
        overdue: false,
      });
      expect(given[0]!.completed_at).not.toBeNull();
      // the room attendants' pool was emptied when it was given to one person: it is not theirs
      expect(await mine(c, RA_B, task)).toBeUndefined();
    }));

  it('a cancelled task does not come back as done', () =>
    inRolledBackTx(async (c) => {
      const task = await roleTask(c);
      await c.query(`update ops.task set status = 'cancelled' where id = $1`, [task]);
      expect(await mine(c, RA, task)).toBeUndefined();
      expect(await opens(c, RA_B, task)).toBe(false);
    }));
});
