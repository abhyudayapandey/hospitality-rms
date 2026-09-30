import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Approval chains (ADR 009): leave and swaps go to the person's department head first,
// falling back up the tree; every step ends with the account owner; the leave HR step is
// a customer setting; whoever may act on a pending step sees what it is about, and keeps a
// summary of what they decided. Checked on the test customers' shapes.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const LATER = `(current_date + 60)`;

async function as<T extends object>(
  c: PoolClient,
  who: string,
  sql: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, ids.user(who), sql, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}

/** Unpaid leave for `who` two months out; returns the workflow request id. */
async function leave(c: PoolClient, who: string, customer = 'TEST-COMPANY'): Promise<string> {
  const type = (
    await c.query<{ id: string }>(
      `select t.id from hr.leave_type t join core.tenant te on te.id = t.tenant_id
        where te.code = $1 and t.code = 'UNPAID_LEAVE'`,
      [customer],
    )
  ).rows[0]!.id;
  const [row] = await as<{ id: string }>(
    c,
    who,
    `select hr.request_leave($1, ${LATER}, ${LATER}) as id`,
    [type],
  );
  return (
    await c.query<{ r: string }>('select wf_request_id r from hr.leave_request where id = $1', [
      row!.id,
    ])
  ).rows[0]!.r;
}

/** Each step: state, the group it went to, and who can act on it (usernames). */
async function route(c: PoolClient, request: string) {
  const { rows } = await c.query<{ step: string; state: string; grp: string; skip: string | null }>(
    `select s.step, s.state, g.code as grp, s.skip_reason as skip
       from wf.step_instance s join core.security_group g on g.id = s.assignee_group_id
      where s.request_id = $1 order by s.seq`,
    [request],
  );
  return rows;
}

async function inbox(c: PoolClient, who: string): Promise<string[]> {
  return (await as<{ request_id: string }>(c, who, 'select request_id from wf.my_inbox()')).map(
    (r) => r.request_id,
  );
}

describe('leave goes to the department head first, falling back up the tree', () => {
  it('full hotel: the department head, then the outlet HR executive', async () => {
    await inRolledBackTx(async (c) => {
      const r = await leave(c, 'test.room-attendant.1.0');
      expect(await route(c, r)).toEqual([
        { step: 'manager_approval', state: 'pending', grp: 'DEPARTMENT_HEAD', skip: null },
        { step: 'hr_approval', state: 'waiting', grp: 'OUTLET_HR', skip: null },
      ]);
      expect(await inbox(c, 'test.executive-housekeeper.1.0')).toContain(r);
      expect(await inbox(c, 'test.general-manager.1.0')).not.toContain(r);
      await as(c, 'test.executive-housekeeper.1.0', `select wf.act($1, 'approve')`, [r]);
      expect(await inbox(c, 'test.hr-executive.1.0')).toContain(r);
      expect(await inbox(c, 'test.hr-executive.1.1')).not.toContain(r);
    });
  });

  it('small hotel: no departments, so the general manager; HR falls back to HR admin', async () => {
    await inRolledBackTx(async (c) => {
      const r = await leave(c, 'test.room-attendant.2.0');
      expect(await route(c, r)).toEqual([
        { step: 'manager_approval', state: 'pending', grp: 'OUTLET_MANAGER', skip: null },
        { step: 'hr_approval', state: 'waiting', grp: 'HR_ADMIN', skip: null },
      ]);
      expect(await inbox(c, 'test.general-manager.2.0')).toContain(r);
    });
  });

  it('the HR step is a customer setting (on unless turned off)', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `update core.tenant set settings = settings || '{"leave_hr_approval": false}'
          where code = 'TEST-COMPANY'`,
      );
      const r = await leave(c, 'test.room-attendant.1.0');
      expect((await route(c, r)).map((s) => [s.step, s.state, s.skip])).toEqual([
        ['manager_approval', 'pending', null],
        ['hr_approval', 'skipped', 'condition'],
      ]);
      await as(c, 'test.executive-housekeeper.1.0', `select wf.act($1, 'approve')`, [r]);
      const state = await c.query<{ state: string }>('select state from wf.request where id = $1', [
        r,
      ]);
      expect(state.rows[0]!.state).toBe('approved');
    });
  });
});

describe('the account owner is the final approver', () => {
  it('Solo Bar: no HR people, so the owner approves the HR step', async () => {
    await inRolledBackTx(async (c) => {
      const r = await leave(c, 'test.solo.cook', 'TEST-SOLO-COMPANY');
      expect(await route(c, r)).toEqual([
        { step: 'manager_approval', state: 'pending', grp: 'DEPARTMENT_HEAD', skip: null },
        { step: 'hr_approval', state: 'waiting', grp: 'ACCOUNT_OWNER', skip: null },
      ]);
      await as(c, 'test.solo.head-cook', `select wf.act($1, 'approve')`, [r]);
      expect(await inbox(c, 'test.solo.bar-manager')).toContain(r);
      await as(c, 'test.solo.bar-manager', `select wf.act($1, 'approve')`, [r]);
      const state = await c.query<{ state: string }>('select state from wf.request where id = $1', [
        r,
      ]);
      expect(state.rows[0]!.state).toBe('approved');
    });
  });

  it('Solo Bar: when the owner approves as manager, the HR step is skipped (same approver)', async () => {
    await inRolledBackTx(async (c) => {
      // the floor manager heads Floor Service, so their own leave goes to the outlet
      // manager: the owner, who is also the final approver of the HR step
      const r = await leave(c, 'test.solo.floor-manager', 'TEST-SOLO-COMPANY');
      expect((await route(c, r)).map((s) => s.grp)).toEqual(['OUTLET_MANAGER', 'ACCOUNT_OWNER']);
      await as(c, 'test.solo.bar-manager', `select wf.act($1, 'approve')`, [r]);
      expect((await route(c, r)).map((s) => [s.state, s.skip])).toEqual([
        ['approved', null],
        ['skipped', 'same_approver'],
      ]);
    });
  });

  it('every process, step and place of both customers has an approver', async () => {
    await inRolledBackTx(async (c) => {
      for (const customer of ['TEST-COMPANY', 'TEST-SOLO-COMPANY'] as const) {
        const { rows } = await c.query('select * from wf.approval_coverage($1)', [
          ids.tenant(customer),
        ]);
        expect(rows, customer).toEqual([]);
      }
      // without its owner, the solo bar's HR step (among others) has no one left
      await c.query('alter table core.role_assignment disable trigger last_account_owner');
      await c.query(
        `update core.role_assignment ra set effective_from = date '2020-01-01',
                effective_to = date '2020-12-31'
           from core.security_group g
          where g.id = ra.group_id and g.code = 'ACCOUNT_OWNER' and ra.user_id = $1`,
        [ids.user('test.solo.bar-manager')],
      );
      const { rows } = await c.query<{ process_type: string; step: string; node_code: string }>(
        'select process_type, step, node_code from wf.approval_coverage($1)',
        [ids.tenant('TEST-SOLO-COMPANY')],
      );
      expect(rows).toContainEqual({
        process_type: 'LEAVE',
        step: 'hr_approval',
        node_code: 'TEST-SOLO-BAR-KITCHEN',
      });
      expect(rows).toContainEqual({
        process_type: 'ROLE_CHANGE',
        step: 'security_approval',
        node_code: 'TEST-SOLO-COMPANY',
      });
    });
  });
});

describe('pending-inbox visibility and decision summaries', () => {
  it('an approver without data access reads the subject only while it waits for them', async () => {
    await inRolledBackTx(async (c) => {
      const r = await leave(c, 'test.solo.cook', 'TEST-SOLO-COMPANY');
      const leaveRow = (
        await c.query<{ id: string }>('select subject_id as id from wf.request where id = $1', [r])
      ).rows[0]!.id;
      // Test Company's account owner holds no LEAVE rights and is not the approver here;
      // the solo owner will be, at the HR step
      const sees = async (who: string) =>
        (await as(c, who, 'select id from hr.leave_request where id = $1', [leaveRow])).length;
      const owner = 'test.solo.bar-manager';
      await as(c, 'test.solo.head-cook', `select wf.act($1, 'approve')`, [r]);

      // an account owner by rights sees no leave; as the pending approver, this one row
      await c.query(
        `delete from core.role_assignment ra using core.security_group g
          where g.id = ra.group_id and g.code = 'OUTLET_MANAGER' and ra.user_id = $1`,
        [ids.user(owner)],
      );
      expect(await sees(owner)).toBe(1);
      const [pending] = await as<{ s: Record<string, unknown> }>(
        c,
        owner,
        'select wf.request_summary($1) as s',
        [r],
      );
      expect(pending!.s).toMatchObject({
        label: 'Leave',
        person: 'Test Cook',
        type: 'Unpaid Leave',
        decided: false,
      });
      expect(await sees('test.account-owner')).toBe(0);
      const other = await attemptAs(
        c,
        ids.user('test.account-owner'),
        'select wf.request_summary($1)',
        [r],
      );
      expect(other.error).toBe('NOT_AUTHORISED');

      await as(c, owner, `select wf.act($1, 'approve')`, [r]);
      // decided: the row is hidden again, the summary of the decision stays
      expect(await sees(owner)).toBe(0);
      const [after] = await as<{ s: Record<string, unknown> }>(
        c,
        owner,
        'select wf.request_summary($1) as s',
        [r],
      );
      expect(after!.s).toMatchObject({ label: 'Leave', decided: true, decision: 'approved' });
      const mine = await as<{ request_id: string; decision: string }>(
        c,
        owner,
        'select request_id, decision from wf.my_decisions()',
      );
      expect(mine).toContainEqual({ request_id: r, decision: 'approved' });
    });
  });
});
