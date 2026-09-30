import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// People at department level (ADR 009, Prompt 7 item 7): rosters built and published per
// department by its head, falling back up the tree; attendance exceptions grouped per
// department and assigned to whoever runs that department's roster.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

// the dev seed rosters this week and next; the week after is still empty
const NEXT_MONDAY = `(date_trunc('week', current_date + 14))::date`;

async function err(c: PoolClient, who: string, sql: string, params: unknown[] = []) {
  return (await attemptAs(c, ids.user(who), sql, params)).error;
}

async function workerOf(c: PoolClient, username: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    'select id from hr.worker where owner_user_id = $1',
    [ids.user(username)],
  );
  return rows[0]!.id;
}

/** An open 'late' exception on a shift at the worker's home node; returns its id. */
async function exception(c: PoolClient, username: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `with w as (select * from hr.worker where owner_user_id = $1),
     s as (insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code)
           select tenant_id, org_node_id, current_date - 1, now() - interval '30 hours',
                  now() - interval '22 hours', role_code from w returning *)
     insert into hr.attendance_exception (tenant_id, org_node_id, worker_id, owner_user_id,
                                          shift_id, local_date, kind, detail)
     select w.tenant_id, w.org_node_id, w.id, w.owner_user_id, s.id, s.local_date, 'late',
            '{"minutes": 20}' from w, s returning id`,
    [ids.user(username)],
  );
  return rows[0]!.id;
}

type Queue = {
  id: string;
  place_name: string;
  worker_name: string;
  assignee_group: string;
  assignee_names: string[];
  assigned_to_me: boolean;
};
async function queue(c: PoolClient, who: string, place: string): Promise<Queue[]> {
  const r = await attemptAs<Queue>(
    c,
    ids.user(who),
    `select id, place_name, worker_name, assignee_group, assignee_names, assigned_to_me
       from hr.exception_queue($1, 'open')`,
    [ids.node(place)],
  );
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows;
}

describe('rosters per department', () => {
  it('the department head builds and publishes their department, not another', async () => {
    await inRolledBackTx(async (c) => {
      const head = 'test.executive-housekeeper.1.0';
      const gen = `select hr.generate_week($1, ${NEXT_MONDAY}) as n`;
      const r = await attemptAs<{ n: number }>(c, ids.user(head), gen, [
        ids.node('TEST-HOTEL-1.0-HOUSEKEEPING'),
      ]);
      expect(r.error).toBeUndefined();
      expect(r.rows![0]!.n).toBeGreaterThan(0);
      expect(
        await err(c, head, `select hr.publish_week($1, ${NEXT_MONDAY})`, [
          ids.node('TEST-HOTEL-1.0-HOUSEKEEPING'),
        ]),
      ).toBeUndefined();
      expect(await err(c, head, gen, [ids.node('TEST-HOTEL-1.0-KITCHEN')])).toBe('NOT_AUTHORISED');
      expect(await err(c, head, gen, [ids.node('TEST-HOTEL-1.0')])).toBe('NOT_AUTHORISED');
    });
  });

  it('a department without a head: the outlet manager builds it', async () => {
    await inRolledBackTx(async (c) => {
      const bar = ids.node('TEST-BAR-3.0-BAR');
      const gen = `select hr.generate_week($1, ${NEXT_MONDAY}) as n`;
      expect(await err(c, 'test.bar-manager.3.0', gen, [bar])).toBeUndefined();
      expect(await err(c, 'test.head-cook.3.0', gen, [bar])).toBe('NOT_AUTHORISED');
      const owner = await c.query<{ g: string }>('select o_group g from hr.roster_owner($1)', [
        bar,
      ]);
      expect(owner.rows[0]!.g).toBe('OUTLET_MANAGER');
    });
  });

  it('an outlet-level shift may take a department’s worker, never another outlet’s', async () => {
    await inRolledBackTx(async (c) => {
      const check = `select code from hr.assignment_violation($1, now() + interval '40 days',
                       now() + interval '40 days 8 hours', $2, 'BARTENDER')`;
      const bartender = await workerOf(c, 'test.bartender.3.0');
      const here = await c.query(check, [bartender, ids.node('TEST-BAR-3.0')]);
      expect(here.rows).toEqual([]);
      const there = await c.query(check, [bartender, ids.node('TEST-HOTEL-1.0-BAR')]);
      expect(there.rows).toEqual([{ code: 'WORKER_NOT_AT_NODE' }]);
    });
  });
});

describe('attendance exceptions per department', () => {
  it('grouped by department, each waiting for that department’s head', async () => {
    await inRolledBackTx(async (c) => {
      const room = await exception(c, 'test.room-attendant.1.0');
      const head = await exception(c, 'test.executive-housekeeper.1.0');
      const guard = await exception(c, 'test.security-guard.1.0');
      const rows = await queue(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0');
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(room)).toMatchObject({
        place_name: 'Test Hotel & Bar 1.0 – Housekeeping',
        assignee_group: 'DEPARTMENT_HEAD',
        assignee_names: ['Test Executive Housekeeper 1.0'],
        assigned_to_me: false,
      });
      // the head's own exception goes up to the outlet managers
      expect(byId.get(head)).toMatchObject({
        assignee_group: 'OUTLET_MANAGER',
        assigned_to_me: true,
      });
      expect(byId.get(guard)!.assignee_group).toBe('DEPARTMENT_HEAD');
      // department order: every department's rows together
      const places = rows.map((r) => r.place_name);
      const runs = places.filter((p, i) => p !== places[i - 1]);
      expect(new Set(runs).size).toBe(runs.length);
      // the department head sees their department's queue only
      const own = await queue(c, 'test.executive-housekeeper.1.0', 'TEST-HOTEL-1.0');
      expect(own.map((r) => r.id)).toContain(room);
      expect(own.map((r) => r.id)).not.toContain(guard);
      // their own exception: visible to them, but waiting for someone else
      expect(own.find((r) => r.id === head)?.assigned_to_me).toBe(false);
    });
  });

  it('the assignee resolves it, even as the account owner without attendance rights', async () => {
    await inRolledBackTx(async (c) => {
      const owner = 'test.solo.bar-manager';
      await c.query(
        `delete from core.role_assignment ra using core.security_group g
          where g.id = ra.group_id and g.code <> 'ACCOUNT_OWNER' and ra.user_id = $1`,
        [ids.user(owner)],
      );
      // the floor manager heads Floor Service; their own exception has only the owner left
      const e = await exception(c, 'test.solo.floor-manager');
      const [row] = (await queue(c, owner, 'TEST-SOLO-BAR')).filter((r) => r.id === e);
      expect(row).toMatchObject({ assignee_group: 'ACCOUNT_OWNER', assigned_to_me: true });
      expect(
        await err(c, owner, `select hr.resolve_exception($1, 'resolved', 'spoke to them')`, [e]),
      ).toBeUndefined();
      // someone neither assigned nor with rights there cannot
      const other = await exception(c, 'test.solo.server');
      expect(
        await err(c, 'test.solo.head-cook', `select hr.resolve_exception($1, 'resolved')`, [other]),
      ).toBe('NOT_AUTHORISED');
    });
  });

  it('the roster gap after approved leave notifies the department head', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `select hr.notify_roster_owner($1, $2, 'roster_gap', '1 shift(s) need cover')`,
        [ids.node('TEST-HOTEL-1.0-HOUSEKEEPING'), ids.user('test.room-attendant.1.0')],
      );
      const { rows } = await c.query<{ u: string }>(
        `select u.username as u from ops.notification n join core.app_user u on u.id = n.owner_user_id
          where n.kind = 'roster_gap' and n.created_at = now()`,
      );
      expect(rows.map((r) => r.u)).toEqual(['test.executive-housekeeper.1.0']);
    });
  });
});
