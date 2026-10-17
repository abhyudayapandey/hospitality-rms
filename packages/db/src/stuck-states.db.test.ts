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
import { clearWorkforce } from '../test/workforce';

// Stuck states and time bombs (ADR 167): a request that could not go through lets go of what
// it held (H7) and transient errors retry for hours (M33); a missing leave balance is the
// type's full year (H8); the audit log's partitions are kept (M45); approvals move on when
// late or when nobody is left to approve (H6); each customer's tick is its own (H10); leave
// meets a shift on the shift's business day and Publish checks the rules again (M30, M31).

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const SAM = 'test.server.3.0';
const FLOOR = 'test.floor-manager.3.0'; // Floor Service's head: first approver of Sam's leave
const OLIVIA = 'test.bar-manager.3.0'; // the outlet's GM: second approver
const FLOOR_SERVICE = 'TEST-BAR-3.0-FLOOR-SERVICE';

async function as<T = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T & object>(c, ids.user(who), sql, params);
  if (r.error !== undefined) throw new Error(`${who}: ${sql}: ${r.error}`);
  return r.rows;
}
const err = async (c: PoolClient, who: string, sql: string, params: unknown[] = []) =>
  (await attemptAs(c, ids.user(who), sql, params)).error;
async function one<T>(c: PoolClient, sql: string, params: unknown[] = []): Promise<T> {
  return (await c.query(sql, params)).rows[0] as T;
}

/** Monday two weeks from now at the outlets (India). */
async function monday(c: PoolClient): Promise<string> {
  return (
    await one<{ d: string }>(
      c,
      `select (hr.week_start((now() at time zone 'Asia/Kolkata')::date) + 14)::text as d`,
    )
  ).d;
}
const leaveType = async (c: PoolClient, code: string) =>
  (
    await one<{ id: string }>(
      c,
      `select id from hr.leave_type where tenant_id = $1 and code = $2`,
      [ids.tenant(), code],
    )
  ).id;
const workerOf = async (c: PoolClient, user: string) =>
  (await one<{ id: string }>(c, 'select id from hr.worker where owner_user_id = $1', [user])).id;

/** Sam asks for leave and both approvers say yes: one pending outbox row. */
async function approvedLeave(
  c: PoolClient,
  from: string,
  to = from,
): Promise<{ leave: string; req: string }> {
  const [l] = await as<{ id: string }>(
    c,
    SAM,
    `select hr.request_leave($1, $2::date, $3::date, 'family') as id`,
    [await leaveType(c, 'EARNED_LEAVE'), from, to],
  );
  const req = (
    await one<{ r: string }>(c, 'select wf_request_id r from hr.leave_request where id = $1', [
      l!.id,
    ])
  ).r;
  await as(c, FLOOR, `select wf.act($1, 'approve')`, [req]);
  await as(c, OLIVIA, `select wf.act($1, 'approve')`, [req]);
  return { leave: l!.id, req };
}

/** The executor's view of one failed attempt (wf.record_failure, as wf_executor). */
async function fail(
  c: PoolClient,
  req: string,
  error: string,
  opts: { final?: boolean; transient?: boolean; at?: string } = {},
): Promise<string> {
  const ob = await one<{ id: string }>(
    c,
    `select id from wf.outbox where request_id = $1 and status = 'pending'`,
    [req],
  );
  await c.query(`update wf.request set state = 'executing' where id = $1 and state = 'approved'`, [
    req,
  ]);
  await actAs(c, 'wf_executor', null);
  const { rows } = await c.query<{ s: string }>(
    `select wf.record_failure($1, $2, coalesce($3::timestamptz, now()), $4, $5) as s`,
    [ob.id, error, opts.at ?? null, opts.final ?? false, opts.transient ?? false],
  );
  await resetRole(c);
  return rows[0]!.s;
}

/** Runs the request's pending outbox rows through hr.execute as wf_executor. */
async function execute(c: PoolClient, req: string): Promise<void> {
  const { rows } = await c.query<{ id: string; handler: string }>(
    `select id, handler from wf.outbox where request_id = $1 and status = 'pending'`,
    [req],
  );
  for (const row of rows) {
    await c.query(
      `update wf.request set state = 'executing' where id = $1 and state = 'approved'`,
      [req],
    );
    await actAs(c, 'wf_executor', null);
    await c.query('select hr.execute($1, $2)', [row.handler, req]);
    await resetRole(c);
    await c.query('select wf.complete_outbox($1)', [row.id]);
  }
}

const notes = async (c: PoolClient, user: string, kind: string) =>
  (
    await c.query<{ title: string; body: string; link: string }>(
      `select title, body, link from ops.notification where owner_user_id = $1 and kind = $2`,
      [ids.user(user), kind],
    )
  ).rows;

// ---------------------------------------------------------------------------
describe('a request that could not go through lets go (H7)', () => {
  it('a failed leave frees its days and dates, says so, and tells the person', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const d = await monday(c);
      const { leave, req } = await approvedLeave(c, d);
      const year = Number(d.slice(0, 4));
      const pending = async () =>
        (
          await as<{ pending_days: string }>(
            c,
            SAM,
            `select pending_days from hr.leave_balances(null, $1) where code = 'EARNED_LEAVE'`,
            [year],
          )
        )[0]!.pending_days;
      expect(Number(await pending())).toBe(1);

      expect(await fail(c, req, 'INSUFFICIENT_LEAVE_BALANCE', { final: true })).toBe('failed');
      const l = await one<{ status: string; decided: boolean }>(
        c,
        'select status, decided_at is not null as decided from hr.leave_request where id = $1',
        [leave],
      );
      expect(l).toEqual({ status: 'failed', decided: true });
      const [words] = await as<{ w: string }>(c, SAM, 'select hr.leave_words($1) w', [leave]);
      expect(words).toEqual({ w: 'It could not go through. You can ask again.' });
      expect(await one(c, 'select hr.leave_state($1) s', [leave])).toEqual({ s: 'failed' });
      expect(Number(await pending())).toBe(0);
      // the team's list still shows it, as could not go through
      const team = await as<{ leave_id: string; status: string }>(
        c,
        OLIVIA,
        'select leave_id, status from hr.team_leave($1, $2::date, $2::date)',
        [ids.node(FLOOR_SERVICE), d],
      );
      expect(team.find((t) => t.leave_id === leave)?.status).toBe('failed');
      expect(await notes(c, SAM, 'leave_failed')).toEqual([
        expect.objectContaining({
          title: 'Your leave could not go through',
          link: `/leave/${leave}`,
        }),
      ]);
      // the same day can be asked for again
      expect(
        await err(c, SAM, `select hr.request_leave($1, $2::date, $2::date)`, [
          await leaveType(c, 'EARNED_LEAVE'),
          d,
        ]),
      ).toBeUndefined();
    });
  });

  it('a failed deactivation lets another be asked; a failed role change says so', async () => {
    await inRolledBackTx(async (c) => {
      const commis = ids.user('test.commis.1.0');
      const [dx] = await as<{ id: string }>(
        c,
        'test.hr-executive.1.0',
        'select hr.request_deactivation($1, $2) as id',
        [commis, 'Left the company'],
      );
      const req = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.deactivation where id = $1', [
          dx!.id,
        ])
      ).r;
      await as(c, 'test.security-admin', `select wf.act($1, 'approve')`, [req]);
      await fail(c, req, 'boom', { final: true });
      expect(
        (
          await one<{ s: string }>(c, 'select status s from hr.deactivation where id = $1', [
            dx!.id,
          ])
        ).s,
      ).toBe('failed');
      expect(await notes(c, 'test.hr-executive.1.0', 'deactivation_failed')).toHaveLength(1);
      expect(
        await err(c, 'test.hr-executive.1.0', 'select hr.request_deactivation($1, $2)', [
          commis,
          'again',
        ]),
      ).toBeUndefined();

      const [rc] = await as<{ id: string }>(
        c,
        'test.account-owner',
        `select hr.request_role_change('grant', $1, 'STOCK_USER', $2, true, null, null, null) as id`,
        [ids.user(SAM), ids.node('TEST-BAR-3.0-KITCHEN-STORE')],
      );
      const rcReq = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.role_change where id = $1', [
          rc!.id,
        ])
      ).r;
      await as(c, 'test.security-admin', `select wf.act($1, 'approve')`, [rcReq]);
      await fail(c, rcReq, 'boom', { final: true });
      expect(
        (await one<{ s: string }>(c, 'select status s from hr.role_change where id = $1', [rc!.id]))
          .s,
      ).toBe('failed');
      expect(await notes(c, 'test.account-owner', 'access_failed')).toHaveLength(1);
    });
  });

  it('a failed order is cancelled, so it can be ordered again, and says why', async () => {
    await inRolledBackTx(async (c) => {
      const kitchen = ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
      const items = (
        await c.query<{ id: string }>(
          `select item_id as id from inv.item_node where delivery_node_id = $1 and archived_at is null
            order by item_id limit 2`,
          [kitchen],
        )
      ).rows.map((r) => r.id);
      const [po] = await as<{ id: string }>(
        c,
        'test.executive-chef.1.0',
        `select inv.request_supplies($1, $2::jsonb, null) as id`,
        [kitchen, JSON.stringify(items.map((item_id) => ({ item_id, qty: 2 })))],
      );
      const req = (
        await one<{ r: string; state: string }>(
          c,
          `select wf_request_id r from inv.purchase_order where id = $1`,
          [po!.id],
        )
      ).r;
      const state = (
        await one<{ s: string }>(c, 'select state s from wf.request where id = $1', [req])
      ).s;
      if (state !== 'approved') {
        await as(c, 'test.general-manager.1.0', `select wf.act($1, 'approve')`, [req]);
      }
      await fail(c, req, 'boom', { final: true });
      expect(
        await one(
          c,
          `select p.status, s.progress from inv.purchase_order p
             join inv.purchase_order_summary s using (id) where p.id = $1`,
          [po!.id],
        ),
      ).toEqual({ status: 'cancelled', progress: 'cancelled' });
      expect(await notes(c, 'test.executive-chef.1.0', 'request_failed')).toEqual([
        expect.objectContaining({
          title: 'Order could not go through',
          link: `/stock/orders/${po!.id}`,
        }),
      ]);
    });
  });

  it('repairs a request that failed before the hook (the migration runs wf.after_failure)', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const d = await monday(c);
      const { leave, req } = await approvedLeave(c, d);
      // failed the old way: the request failed, the leave kept 'submitted'
      await c.query(
        `update wf.request set state = 'failed', failure_code = 'HANDLER_ERROR' where id = $1`,
        [req],
      );
      await c.query(`update wf.outbox set status = 'failed' where request_id = $1`, [req]);
      expect(
        (
          await one<{ s: string }>(c, 'select status s from hr.leave_request where id = $1', [
            leave,
          ])
        ).s,
      ).toBe('submitted');
      await c.query('select wf.after_failure(id) from wf.request where state = $1', ['failed']);
      expect(
        (
          await one<{ s: string }>(c, 'select status s from hr.leave_request where id = $1', [
            leave,
          ])
        ).s,
      ).toBe('failed');
      // idempotent: a second run tells nobody again
      await c.query('select wf.after_failure($1)', [req]);
      expect(await notes(c, SAM, 'leave_failed')).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
describe('transient errors retry for hours (M33)', () => {
  it('back off 1 min doubling to 30 min, 12 tries, counted apart from other errors', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const { leave, req } = await approvedLeave(c, await monday(c));
      const row = async () =>
        one<{ status: string; attempts: number; transient: number; gap: number }>(
          c,
          `select status, attempts, transient_attempts as transient,
                  extract(epoch from next_attempt_at - $2::timestamptz)::int as gap
             from wf.outbox where request_id = $1`,
          [req, '2030-01-01T00:00:00Z'],
        );
      const at = '2030-01-01T00:00:00Z';
      // two ordinary errors: one try left
      expect(await fail(c, req, 'supplier down', { at })).toBe('pending');
      expect(await fail(c, req, 'supplier down', { at })).toBe('pending');
      const gaps: number[] = [];
      for (let i = 0; i < 11; i++) {
        expect(await fail(c, req, 'deadlock detected', { at, transient: true })).toBe('pending');
        gaps.push((await row()).gap);
      }
      expect(gaps).toEqual([60, 120, 240, 480, 960, 1800, 1800, 1800, 1800, 1800, 1800]);
      expect(await row()).toMatchObject({ status: 'pending', attempts: 13, transient: 11 });
      // the twelfth transient error gives up, and the leave lets go
      expect(await fail(c, req, 'deadlock detected', { at, transient: true })).toBe('failed');
      expect(
        (
          await one<{ s: string }>(c, 'select status s from hr.leave_request where id = $1', [
            leave,
          ])
        ).s,
      ).toBe('failed');
    });
  });

  it('a third ordinary error still fails, whatever transient errors came between', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const { req } = await approvedLeave(c, await monday(c));
      expect(await fail(c, req, 'boom')).toBe('pending');
      expect(await fail(c, req, 'lock timeout', { transient: true })).toBe('pending');
      expect(await fail(c, req, 'boom')).toBe('pending');
      expect(await fail(c, req, 'boom')).toBe('failed');
      expect(
        (
          await one<{ code: string }>(c, 'select failure_code code from wf.request where id = $1', [
            req,
          ])
        ).code,
      ).toBe('HANDLER_ERROR');
    });
  });
});

// ---------------------------------------------------------------------------
describe('a missing leave balance is the full year (H8)', () => {
  it('leave next January is allowed, and approving it makes the balance', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const next = (await one<{ y: number }>(c, `select extract(year from now())::int + 1 as y`)).y;
      const type = await leaveType(c, 'EARNED_LEAVE');
      const worker = await workerOf(c, ids.user(SAM));
      await c.query('delete from hr.leave_balance where worker_id = $1 and year = $2', [
        worker,
        next,
      ]);
      const [bal] = await as<{ entitled_days: string; available_days: string }>(
        c,
        SAM,
        `select entitled_days, available_days from hr.leave_balances(null, $1)
          where code = 'EARNED_LEAVE'`,
        [next],
      );
      expect(bal).toEqual({ entitled_days: '18.0', available_days: '18.0' });
      const { leave, req } = await approvedLeave(c, `${next}-01-05`, `${next}-01-06`);
      expect(leave).toBeTruthy();
      await execute(c, req);
      expect(
        await one(
          c,
          `select entitled_days::text e, used_days::text u from hr.leave_balance
            where worker_id = $1 and leave_type_id = $2 and year = $3`,
          [worker, type, next],
        ),
      ).toEqual({ e: '18.0', u: '2.0' });
      // more than the year holds is still refused
      expect(
        await err(c, SAM, `select hr.request_leave($1, $2::date, $3::date)`, [
          type,
          `${next}-03-01`,
          `${next}-03-17`,
        ]),
      ).toBe('INSUFFICIENT_LEAVE_BALANCE');
    });
  });

  it('someone added in the app can take balanced leave', async () => {
    await inRolledBackTx(async (c) => {
      const [made] = await as<{ r: { user_id: string } }>(
        c,
        'test.general-manager.1.0',
        `select core.create_user('test.new-commis.1.0', 'New Commis', $1, 'COMMIS') as r`,
        [ids.node('TEST-HOTEL-1.0-KITCHEN')],
      );
      const user = made!.r.user_id;
      await c.query(`update core.app_user set status = 'active' where id = $1`, [user]);
      const worker = await workerOf(c, user);
      expect(
        (
          await one<{ n: number }>(
            c,
            'select count(*)::int n from hr.leave_balance where worker_id = $1',
            [worker],
          )
        ).n,
      ).toBe(0);
      const type = await leaveType(c, 'CASUAL_LEAVE');
      const d = await monday(c);
      const r = await attemptAs<{ id: string }>(
        c,
        user,
        `select hr.request_leave($1, $2::date, $2::date + 1) as id`,
        [type, d],
      );
      expect(r.error).toBeUndefined();
      const req = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.leave_request where id = $1', [
          r.rows![0]!.id,
        ])
      ).r;
      // approved (the chain is tested elsewhere): the executor makes the balance
      await c.query(`update wf.request set state = 'approved' where id = $1`, [req]);
      await c.query(
        `insert into wf.outbox (request_id, handler, domain_code, initiator_id, tenant_id)
         select id, 'hr.leave.apply', domain_code, initiator_id, tenant_id from wf.request
          where id = $1 and not exists (select 1 from wf.outbox where request_id = $1)`,
        [req],
      );
      await execute(c, req);
      expect(
        await one(
          c,
          `select entitled_days::text e, used_days::text u from hr.leave_balance
            where worker_id = $1 and leave_type_id = $2`,
          [worker, type],
        ),
      ).toEqual({ e: '12.0', u: '2.0' });
    });
  });
});

// ---------------------------------------------------------------------------
describe('the audit log keeps its monthly partitions (M45)', () => {
  it('the nightly job makes the months ahead and moves rows out of the default partition', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `insert into audit.log (occurred_at, actor_kind, table_name, op)
         values ('2031-05-10T12:00:00Z', 'human', 'test.thing', 'INSERT')`,
      );
      const where = async () =>
        (
          await one<{ t: string }>(
            c,
            `select tableoid::regclass::text t from audit.log where table_name = 'test.thing'`,
          )
        ).t;
      expect(await where()).toBe('audit.log_default');
      await actAs(c, 'wf_executor', null);
      const made = await one<{ n: number }>(c, 'select audit.keep_partitions(3) as n');
      expect(made.n).toBeGreaterThanOrEqual(1);
      expect((await one<{ n: number }>(c, 'select audit.keep_partitions(3) as n')).n).toBe(0);
      await resetRole(c);
      expect(await where()).toBe('audit.log_y2031m05');
      // this month and three ahead exist
      const ahead = await one<{ missing: number }>(
        c,
        `select count(*)::int as missing from generate_series(0, 3) i
          where to_regclass(format('audit.log_y%sm%s',
                  to_char(date_trunc('month', now() at time zone 'utc') + make_interval(months => i), 'YYYY'),
                  to_char(date_trunc('month', now() at time zone 'utc') + make_interval(months => i), 'MM'))) is null`,
      );
      expect(ahead.missing).toBe(0);
      expect((await one<{ n: number }>(c, 'select count(*)::int n from audit.log_default')).n).toBe(
        0,
      );
    });
  });
});

// ---------------------------------------------------------------------------
describe('approvals move on (H6)', () => {
  const step = async (c: PoolClient, req: string) =>
    one<{ grp: string; n: number }>(
      c,
      `select g.code as grp, s.escalation_count as n from wf.step_instance s
         join core.security_group g on g.id = s.assignee_group_id
        where s.request_id = $1 and s.state = 'pending'`,
      [req],
    );
  const tick = async (c: PoolClient, at: string, tenant: string) => {
    await actAs(c, 'wf_executor', null);
    const r = await one<{ escalated: number; rerouted: number; unroutable: number }>(
      c,
      'select * from wf.approvals_tick($1::timestamptz, $2)',
      [at, tenant],
    );
    await resetRole(c);
    return r;
  };

  it('a step past its SLA goes up the chain; another customer is not touched', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const [l] = await as<{ id: string }>(
        c,
        SAM,
        `select hr.request_leave($1, $2::date, $2::date) as id`,
        [await leaveType(c, 'EARNED_LEAVE'), await monday(c)],
      );
      const req = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.leave_request where id = $1', [
          l!.id,
        ])
      ).r;
      expect(await step(c, req)).toEqual({ grp: 'DEPARTMENT_HEAD', n: 0 });
      const later = (await one<{ t: string }>(c, `select (now() + interval '49 hours')::text t`)).t;
      await tick(c, later, ids.tenant('TEST-SOLO-COMPANY'));
      expect(await step(c, req)).toEqual({ grp: 'DEPARTMENT_HEAD', n: 0 });
      expect((await tick(c, later, ids.tenant())).escalated).toBeGreaterThanOrEqual(1);
      expect(await step(c, req)).toMatchObject({ n: 1 });
      expect((await step(c, req)).grp).not.toBe('DEPARTMENT_HEAD');
    });
  });

  it('a step whose only approver left goes up the chain at once', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const [l] = await as<{ id: string }>(
        c,
        SAM,
        `select hr.request_leave($1, $2::date, $2::date) as id`,
        [await leaveType(c, 'EARNED_LEAVE'), await monday(c)],
      );
      const req = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.leave_request where id = $1', [
          l!.id,
        ])
      ).r;
      const inbox = async (who: string) =>
        (await as<{ request_id: string }>(c, who, 'select request_id from wf.my_inbox()')).map(
          (r) => r.request_id,
        );
      expect(await inbox(FLOOR)).toContain(req);
      expect(await inbox(OLIVIA)).not.toContain(req);
      // nothing to do while the head is here
      const now = (await one<{ t: string }>(c, `select now()::text t`)).t;
      await tick(c, now, ids.tenant());
      expect(await step(c, req)).toEqual({ grp: 'DEPARTMENT_HEAD', n: 0 });
      // the head leaves the company
      await c.query(`update core.app_user set status = 'inactive' where id = $1`, [
        ids.user(FLOOR),
      ]);
      expect((await tick(c, now, ids.tenant())).rerouted).toBeGreaterThanOrEqual(1);
      expect(await step(c, req)).toEqual({ grp: 'OUTLET_MANAGER', n: 1 });
      expect(await inbox(OLIVIA)).toContain(req);
    });
  });
});

// ---------------------------------------------------------------------------
describe("each customer's tick is its own (H10)", () => {
  it('a job for one customer runs while another customer fails', async () => {
    await inRolledBackTx(async (c) => {
      const solo = ids.tenant('TEST-SOLO-COMPANY');
      const company = ids.tenant();
      await c.query(`
        create function public.zz_tick_breaks() returns trigger language plpgsql as $f$
        begin raise exception 'a bad template'; end $f$;
        create trigger zz_tick_breaks before insert on ops.task for each row
          when (new.tenant_id = '${solo}') execute function public.zz_tick_breaks();`);
      const at = (await one<{ t: string }>(c, `select (now() + interval '3 days')::text t`)).t;
      const count = async (tenant: string) =>
        (
          await one<{ n: number }>(
            c,
            `select count(*)::int n from ops.task where tenant_id = $1 and kind = 'checklist'`,
            [tenant],
          )
        ).n;
      const before = await count(company);
      await actAs(c, 'wf_executor', null);
      await c.query('savepoint solo');
      await expect(c.query('select * from ops.tasks_tick($1, $2)', [at, solo])).rejects.toThrow(
        'a bad template',
      );
      await c.query('rollback to savepoint solo');
      const [r] = (
        await c.query<{ created: number }>('select * from ops.tasks_tick($1, $2)', [at, company])
      ).rows;
      await c.query('select ops.expiry_alerts($1, $2)', [at, company]);
      await c.query('select * from ops.compliance_tick($1, $2)', [at, company]);
      const tenants = (
        await c.query<{ code: string }>('select code from ops.tick_tenants()')
      ).rows.map((t) => t.code);
      await resetRole(c);
      expect(r!.created).toBeGreaterThan(0);
      expect(await count(company)).toBe(before + r!.created);
      expect(tenants).toEqual(expect.arrayContaining(['TEST-COMPANY', 'TEST-SOLO-COMPANY']));
    });
  });
});

// ---------------------------------------------------------------------------
describe('leave and the roster (M30, M31)', () => {
  /** A published SERVER shift at Floor Service on monday + day, local start, hours long. */
  async function shift(
    c: PoolClient,
    d: string,
    day: number,
    time: string,
    hours: number,
    status: 'published' | 'draft' = 'published',
  ): Promise<string> {
    const { rows } = await c.query<{ id: string }>(
      `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code,
                             headcount, status, published_at)
       values ($1, $2, $3::date + $4::int,
               ($3::date + $4::int + $5::time) at time zone 'Asia/Kolkata',
               ($3::date + $4::int + $5::time) at time zone 'Asia/Kolkata' + make_interval(hours => $6),
               'SERVER', 2, $7, case when $7 = 'published' then now() end)
       returning id`,
      [ids.tenant(), ids.node(FLOOR_SERVICE), d, day, time, hours, status],
    );
    return rows[0]!.id;
  }
  const assign = async (c: PoolClient, s: string, worker: string) =>
    (
      await as<{ id: string }>(c, OLIVIA, `select hr.assign($1, $2, '{}'::text[]) as id`, [
        s,
        worker,
      ])
    )[0]!.id;
  const status = async (c: PoolClient, a: string) =>
    (await one<{ s: string }>(c, 'select status s from hr.shift_assignment where id = $1', [a])).s;

  it("leave from Tuesday keeps Monday night's shift, and Monday night can still be rostered", async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const d = await monday(c);
      const sam = await workerOf(c, ids.user(SAM));
      const monNight = await shift(c, d, 0, '19:00', 9); // to 04:00 Tuesday
      const a = await assign(c, monNight, sam);
      await c.query(
        `update hr.shift_assignment set status = 'assigned' where id = $1 and status = 'pending'`,
        [a],
      );
      const tue = (await one<{ t: string }>(c, `select ($1::date + 1)::text t`, [d])).t;
      const { req } = await approvedLeave(c, tue);
      await execute(c, req);
      expect(await status(c, a)).toBe('assigned');
      // another Monday night shift for Sam is checked against Monday, not Tuesday
      const checks = await c.query<{ code: string }>(
        `select code from hr.assignment_checks($1, ($2::date + time '19:00') at time zone 'Asia/Kolkata',
                 ($2::date + time '19:00') at time zone 'Asia/Kolkata' + interval '9 hours', $3, 'SERVER', $4)`,
        [sam, d, ids.node(FLOOR_SERVICE), a],
      );
      expect(checks.rows.map((r) => r.code)).not.toContain('LEAVE_CONFLICT');
    });
  });

  it("leave on Monday takes Monday night's shift", async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const d = await monday(c);
      const sam = await workerOf(c, ids.user(SAM));
      const sunNight = await shift(c, d, -1, '19:00', 9); // Sunday night into Monday
      const monNight = await shift(c, d, 0, '19:00', 9);
      const aSun = await assign(c, sunNight, sam);
      const aMon = await assign(c, monNight, sam);
      const { req } = await approvedLeave(c, d);
      await execute(c, req);
      expect(await status(c, aMon)).toBe('dropped');
      expect(await status(c, aSun)).not.toBe('dropped');
    });
  });

  it('Publish leaves out what breaks a rule now and says who and when', async () => {
    await inRolledBackTx(async (c) => {
      await clearWorkforce(c);
      const d = await monday(c);
      const sam = await workerOf(c, ids.user(SAM));
      const fri = await shift(c, d, 4, '09:00', 8);
      const thu = await shift(c, d, 3, '09:00', 8, 'draft');
      const aFri = await assign(c, fri, sam); // a waiting change on a published shift
      const aThu = await assign(c, thu, sam); // on a draft shift
      expect([await status(c, aFri), await status(c, aThu)]).toEqual(['pending', 'assigned']);
      // leave for Thursday and Friday approved another way since (an import, say)
      await c.query(
        `insert into hr.leave_request (tenant_id, worker_id, owner_user_id, org_node_id,
                                       leave_type_id, from_date, to_date, days, status)
         select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, $2, $3::date + 3, $3::date + 4, 2,
                'approved'
           from hr.worker w where w.id = $1`,
        [sam, await leaveType(c, 'EARNED_LEAVE'), d],
      );
      const out = await as<{ worker_name: string; local_date: string; words: string }>(
        c,
        OLIVIA,
        `select worker_name, local_date::text, words from hr.publish_left_out($1, $2::date)
          order by local_date`,
        [ids.node(FLOOR_SERVICE), d],
      );
      expect(out.map((o) => o.words)).toEqual(['on leave', 'on leave']);
      expect(
        await err(c, SAM, 'select * from hr.publish_left_out($1, $2::date)', [
          ids.node(FLOOR_SERVICE),
          d,
        ]),
      ).toBe('NOT_AUTHORISED');
      await as(c, OLIVIA, 'select hr.publish_week($1, $2::date)', [ids.node(FLOOR_SERVICE), d]);
      expect([await status(c, aFri), await status(c, aThu)]).toEqual(['dropped', 'dropped']);
      expect(
        (
          await one<{ n: number }>(
            c,
            `select count(*)::int n from ops.notification where owner_user_id = $1
              and title = 'New shift added'`,
            [ids.user(SAM)],
          )
        ).n,
      ).toBe(0);
    });
  });
});
