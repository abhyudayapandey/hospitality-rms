import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Rounds follow the roster (ADR 148): a job-role task goes to the role's people who work at
// its due time (on a published shift, or clocked in). Someone with no shift at all in the
// week around it isn't on the roster (a manager) and still gets their role's rounds. When
// nobody of the role works then, it goes to the department head. A role whose people sit at
// the outlet gets the rounds of the outlet's departments (the Assistant Manager's Lock-up).
// The tests work 40 days ahead, where the seed has no shifts, and add their own.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const BAR = 'TEST-HOTEL-1.0-BAR';
const A = 'test.bartender.1.0';
const B = 'test.bartender-b.1.0';
const HEADS = ['test.bar-manager.1.0', 'test.fandb-manager.1.0'].sort();

/** India-time timestamp `days` ahead at `hhmm` (the test data's zone). */
async function at(c: pg.PoolClient, days: number, hhmm: string): Promise<string> {
  const { rows } = await c.query<{ t: string }>(
    `select ((((now() at time zone 'Asia/Kolkata')::date + $1::int) + $2::time)
              at time zone 'Asia/Kolkata')::text t`,
    [days, hhmm],
  );
  return rows[0]!.t;
}

async function shift(c: pg.PoolClient, username: string, from: string, to: string) {
  const { rows } = await c.query<{ id: string; worker: string; node: string }>(
    `select w.id worker, w.org_node_id node, null::uuid id from hr.worker w
      where w.owner_user_id = $1 and w.status = 'active'`,
    [ids.user(username)],
  );
  const w = rows[0]!;
  const s = await c.query<{ id: string }>(
    `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code,
                           status, published_at)
     select w.tenant_id, w.org_node_id, ($2::timestamptz at time zone 'Asia/Kolkata')::date,
            $2, $3, w.role_code, 'published', now()
       from hr.worker w where w.id = $1 returning id`,
    [w.worker, from, to],
  );
  await c.query(
    `insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                      start_at, end_at)
     select w.tenant_id, $2, w.id, w.owner_user_id, $5, $3, $4 from hr.worker w where w.id = $1`,
    [w.worker, s.rows[0]!.id, from, to, w.node],
  );
}

async function task(c: pg.PoolClient, node: string, role: string, due: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode, job_role_code)
     values ($1, $2, 'one_off', 'Test round', $3, 'job_role', $4) returning id`,
    [ids.tenant(), ids.node(node), due, role],
  );
  return rows[0]!.id;
}

/** Usernames in the task's pool (who sees it and is told). */
async function pool(c: pg.PoolClient, id: string): Promise<string[]> {
  const { rows } = await c.query<{ username: string }>(
    `select u.username from ops.task t, ops.task_people(t) p join core.app_user u on u.id = p
      where t.id = $1 order by 1`,
    [id],
  );
  return rows.map((r) => r.username).sort();
}

describe('rounds follow the roster', () => {
  it('a round goes to the role’s people on shift at its due time, not to one who is off', async () => {
    await inRolledBackTx(async (c) => {
      await shift(c, A, await at(c, 40, '09:00'), await at(c, 40, '17:00'));
      // B is on the roster that week, just not that day
      await shift(c, B, await at(c, 41, '09:00'), await at(c, 41, '17:00'));
      const t = await task(c, BAR, 'BARTENDER', await at(c, 40, '10:00'));
      expect(await pool(c, t)).toEqual([A]);
    });
  });

  it('a round due after everyone’s shift goes to the department head', async () => {
    await inRolledBackTx(async (c) => {
      await shift(c, A, await at(c, 40, '09:00'), await at(c, 40, '17:00'));
      await shift(c, B, await at(c, 41, '09:00'), await at(c, 41, '17:00'));
      const t = await task(c, BAR, 'BARTENDER', await at(c, 40, '22:00'));
      expect(await pool(c, t)).toEqual(HEADS);
    });
  });

  it('a shift’s first and last minute count as on shift', async () => {
    await inRolledBackTx(async (c) => {
      await shift(c, A, await at(c, 40, '09:00'), await at(c, 40, '17:00'));
      await shift(c, B, await at(c, 40, '17:00'), await at(c, 41, '01:00'));
      expect(await pool(c, await task(c, BAR, 'BARTENDER', await at(c, 40, '09:00')))).toEqual([A]);
      expect(await pool(c, await task(c, BAR, 'BARTENDER', await at(c, 40, '17:00')))).toEqual(
        [A, B].sort(),
      );
      // a night shift runs past midnight
      expect(await pool(c, await task(c, BAR, 'BARTENDER', await at(c, 41, '00:30')))).toEqual([B]);
    });
  });

  it('someone clocked in at the due time has it, with or without a shift', async () => {
    await inRolledBackTx(async (c) => {
      // both on the roster this week, neither on shift now
      await shift(c, A, await at(c, 3, '09:00'), await at(c, 3, '17:00'));
      await shift(c, B, await at(c, 3, '09:00'), await at(c, 3, '17:00'));
      await c.query(
        `insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id,
                                    clock_in_at, in_source, in_key)
         select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, now() - interval '1 hour',
                'online', 'test-' || w.id from hr.worker w where w.owner_user_id = $1`,
        [ids.user(A)],
      );
      const { rows } = await c.query<{ t: string }>(
        `select (now() - interval '10 minutes')::text t`,
      );
      expect(await pool(c, await task(c, BAR, 'BARTENDER', rows[0]!.t))).toEqual([A]);
    });
  });

  it('people with no shift in the week around it are not on the roster and keep their rounds', async () => {
    await inRolledBackTx(async (c) => {
      const t = await task(c, BAR, 'BARTENDER', await at(c, 40, '22:00'));
      expect(await pool(c, t)).toEqual([A, B].sort());
    });
  });

  it('a role whose people sit at the outlet gets the rounds of its departments', async () => {
    await inRolledBackTx(async (c) => {
      const t = await task(c, BAR, 'ASSISTANT_GENERAL_MANAGER', await at(c, 40, '23:00'));
      expect(await pool(c, t)).toEqual(['test.assistant-general-manager.1.0']);
    });
  });

  it('the person sees it on their To do list; the one who is off does not', async () => {
    await inRolledBackTx(async (c) => {
      await shift(c, A, await at(c, 40, '09:00'), await at(c, 40, '17:00'));
      await shift(c, B, await at(c, 41, '09:00'), await at(c, 41, '17:00'));
      const t = await task(c, BAR, 'BARTENDER', await at(c, 40, '10:00'));
      const mine = async (u: string) => {
        await actAs(c, 'app_rw', ids.user(u));
        const { rows } = await c.query<{ id: string }>(`select id from ops.my_tasks()`);
        await c.query('reset role');
        return rows.some((r) => r.id === t);
      };
      expect(await mine(A)).toBe(true);
      expect(await mine(B)).toBe(false);
    });
  });
});
