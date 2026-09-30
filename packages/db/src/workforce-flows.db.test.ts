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
import {
  clearWorkforce,
  newUser,
  newWorker,
  tenantOf,
  workerFor,
  type JobRole,
} from '../test/workforce';

// LEAVE, SHIFT_SWAP and ROLE_CHANGE end to end (ADR 008): request -> approvals -> executor
// handler, with balances, roster blocks, excluded approvers, approval-time rule checks and
// same-tenant guards. Self-service RLS on leave and swaps is checked here too.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

interface Fx {
  tenant: string;
  monday: string;
  annual: string; // leave type with 12 days
  unpaid: string;
  sam: string;
  pat: { userId: string; workerId: string };
  olivia: string;
  mia: { userId: string; workerId: string };
  omar: { userId: string; workerId: string };
}

async function fixture(c: PoolClient): Promise<Fx> {
  await clearWorkforce(c);
  const tenant = await tenantOf(c, ids);
  const monday = (
    await c.query<{ d: string }>(
      `select (hr.week_start((now() at time zone 'Asia/Kolkata')::date) + 14)::text as d`,
    )
  ).rows[0]!.d;
  const sam = await workerFor(c, ids, 'test.server.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE', 'SERVER');
  const olivia = await workerFor(
    c,
    ids,
    'test.bar-manager.3.0',
    'TEST-BAR-3.0-FLOOR-SERVICE',
    'MANAGER',
  );
  // the Bar Manager's worker sits at the outlet; these flows roster her in Floor Service
  await c.query(`update hr.worker set org_node_id = $2, role_code = 'MANAGER' where id = $1`, [
    olivia,
    ids.node('TEST-BAR-3.0-FLOOR-SERVICE'),
  ]);
  const pat = await newWorker(c, ids, 'Pat Server', 'TEST-BAR-3.0-FLOOR-SERVICE', 'SERVER');
  const mia = await newWorker(c, ids, 'Mia Manager', 'TEST-BAR-3.0-FLOOR-SERVICE', 'MANAGER');
  const omar = await newWorker(c, ids, 'Omar B Manager', 'TEST-GUEST-HOUSE-2.0', 'MANAGER', [
    ['OUTLET_MANAGER', 'TEST-GUEST-HOUSE-2.0'],
  ]);
  const types = await c.query<{ code: string; id: string }>(
    `insert into hr.leave_type (tenant_id, code, name, annual_days)
     values ($1, 'ZZ_ANNUAL', 'Annual', 12), ($1, 'ZZ_UNPAID', 'Unpaid', null)
     returning code, id`,
    [tenant],
  );
  const annual = types.rows.find((r) => r.code === 'ZZ_ANNUAL')!.id;
  const unpaid = types.rows.find((r) => r.code === 'ZZ_UNPAID')!.id;
  await c.query(
    `insert into hr.leave_balance (tenant_id, worker_id, owner_user_id, org_node_id,
                                   leave_type_id, year, entitled_days)
     select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, $1, y, 12
       from hr.worker w, (select distinct extract(year from d)::int y
                            from unnest(array[$2::date, $2::date + 60]) d) years
      where w.tenant_id = $3
     on conflict do nothing`,
    [annual, monday, tenant],
  );
  return { tenant, monday, annual, unpaid, sam, pat, olivia, mia, omar };
}

/** A published shift at Outlet A on monday + day, local start time. */
async function shift(
  c: PoolClient,
  f: Fx,
  day: number,
  time = '09:00',
  hours = 8,
  role: JobRole = 'SERVER',
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code,
                           headcount, status, published_at)
     values ($1, $2, $3::date + $4::int,
             ($3::date + $4::int + $5::time) at time zone 'Asia/Kolkata',
             ($3::date + $4::int + $5::time) at time zone 'Asia/Kolkata' + make_interval(hours => $6),
             $7, 2, 'published', now())
     returning id`,
    [f.tenant, ids.node('TEST-BAR-3.0-FLOOR-SERVICE'), f.monday, day, time, hours, role],
  );
  return rows[0]!.id;
}

async function as<T = Record<string, unknown>>(
  c: PoolClient,
  user: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T & object>(c, user, sql, params);
  if (r.error !== undefined) throw new Error(`${sql}: ${r.error}`);
  return r.rows;
}

async function first<T = Record<string, unknown>>(
  c: PoolClient,
  user: string,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const rows = await as<T>(c, user, sql, params);
  if (!rows[0]) throw new Error(`${sql}: no row`);
  return rows[0];
}

async function err(c: PoolClient, user: string, sql: string, params: unknown[] = []) {
  return (await attemptAs(c, user, sql, params)).error;
}

async function assign(c: PoolClient, shiftId: string, workerId: string): Promise<string> {
  const [r] = await as<{ id: string }>(
    c,
    ids.user('test.bar-manager.3.0'),
    'select hr.assign($1, $2) as id',
    [shiftId, workerId],
  );
  return r!.id;
}

/** Runs the pending outbox rows of one request through hr.execute as wf_executor. */
async function execute(c: PoolClient, requestId: string): Promise<void> {
  const { rows } = await c.query<{ id: string; handler: string }>(
    `select id, handler from wf.outbox where request_id = $1 and status = 'pending'`,
    [requestId],
  );
  for (const row of rows) {
    await c.query(
      `update wf.request set state = 'executing' where id = $1 and state = 'approved'`,
      [requestId],
    );
    await actAs(c, 'wf_executor', null);
    await c.query('select hr.execute($1, $2)', [row.handler, requestId]);
    await resetRole(c);
    await c.query('select wf.complete_outbox($1)', [row.id]);
  }
}

async function inbox(c: PoolClient, user: string): Promise<string[]> {
  return (await as<{ request_id: string }>(c, user, 'select request_id from wf.my_inbox()')).map(
    (r) => r.request_id,
  );
}

async function one<T>(c: PoolClient, sql: string, params: unknown[] = []): Promise<T> {
  return (await c.query(sql, params)).rows[0] as T;
}

const SAM = () => ids.user('test.server.3.0');
const OLIVIA = () => ids.user('test.bar-manager.3.0');
const HARPER = () => ids.user('test.hr-admin');
// Floor Service's department head: first approver of its people's leave and swaps (ADR 009)
const FLOOR = () => ids.user('test.floor-manager.3.0');
const OWEN = () => ids.user('test.account-owner');
const ARIA = () => ids.user('test.area-manager');
const SASHA = () => ids.user('test.security-admin');

// ---------------------------------------------------------------------------
describe('LEAVE', () => {
  it('request -> department head -> HR -> apply: balance used, shifts dropped, roster blocked', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const wed = await shift(c, f, 2);
      const thu = await shift(c, f, 3);
      const fri = await shift(c, f, 4);
      const [aWed, aThu] = [await assign(c, wed, f.sam), await assign(c, thu, f.sam)];
      await assign(c, fri, f.sam);

      const { id: leave } = await first<{ id: string }>(
        c,
        SAM(),
        `select hr.request_leave($1, $2::date + 2, $2::date + 3, 'family') as id`,
        [f.annual, f.monday],
      );
      const req = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.leave_request where id = $1', [
          leave,
        ])
      ).r;
      expect(await inbox(c, FLOOR())).toContain(req);
      expect(await inbox(c, OLIVIA())).not.toContain(req); // the department head comes first

      // the approval screen lists what approval will drop
      const drops = await as<{ assignment_id: string }>(
        c,
        OLIVIA(),
        'select assignment_id from hr.leave_conflicts($1)',
        [leave],
      );
      expect(drops.map((d) => d.assignment_id)).toEqual([aWed, aThu]);
      // balance shows the pending days
      const [bal] = await as<{ pending_days: string; available_days: string }>(
        c,
        SAM(),
        `select pending_days, available_days from hr.leave_balances(null, extract(year from $1::date)::int)
          where code = 'ZZ_ANNUAL'`,
        [f.monday],
      );
      expect(bal).toEqual({ pending_days: '2.0', available_days: '10.0' });

      await as(c, FLOOR(), `select wf.act($1, 'approve')`, [req]);
      // no Outlet HR at Test Bar 3.0: the HR step falls back to the company HR admin
      expect(await inbox(c, HARPER())).toContain(req);
      await as(c, HARPER(), `select wf.act($1, 'approve')`, [req]);
      await execute(c, req);

      expect(
        (
          await one<{ s: string }>(c, 'select status s from hr.leave_request where id = $1', [
            leave,
          ])
        ).s,
      ).toBe('approved');
      const used = await one<{ u: string }>(
        c,
        `select used_days u from hr.leave_balance where worker_id = $1 and leave_type_id = $2
            and year = extract(year from $3::date)`,
        [f.sam, f.annual, f.monday],
      );
      expect(used.u).toBe('2.0');
      const statuses = await c.query<{ id: string; status: string; drop_reason: string | null }>(
        `select id, status, drop_reason from hr.shift_assignment where worker_id = $1 order by start_at`,
        [f.sam],
      );
      expect(statuses.rows.map((r) => [r.status, r.drop_reason])).toEqual([
        ['dropped', 'leave'],
        ['dropped', 'leave'],
        ['assigned', null],
      ]);
      // approved leave blocks the roster slot
      expect(await err(c, OLIVIA(), 'select hr.assign($1, $2)', [wed, f.sam])).toBe(
        'LEAVE_CONFLICT',
      );
      // notifications: the worker, and whoever runs their roster (the department head,
      // not the outlet manager) about the gap
      const kinds = async (who: string) =>
        (await as<{ kind: string }>(c, who, 'select kind from ops.notification')).map(
          (n) => n.kind,
        );
      expect(await kinds(SAM())).toContain('leave_approved');
      expect(await kinds(FLOOR())).toContain('roster_gap');
      expect(await kinds(OLIVIA())).not.toContain('roster_gap');
    });
  });

  it('checks the balance at request time, counting pending requests', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const req = `select hr.request_leave($1, $2::date + $3::int, $2::date + $4::int) as id`;
      expect(await err(c, SAM(), req, [f.annual, f.monday, 0, 12])).toBe(
        'INSUFFICIENT_LEAVE_BALANCE',
      );
      await as(c, SAM(), req, [f.annual, f.monday, 0, 7]); // 8 days pending
      expect(await err(c, SAM(), req, [f.annual, f.monday, 10, 14])).toBe(
        'INSUFFICIENT_LEAVE_BALANCE',
      );
      // unpaid leave has no balance
      await as(c, SAM(), req, [f.unpaid, f.monday, 10, 14]);
      expect(await err(c, SAM(), req, [f.unpaid, f.monday, 12, 12])).toBe('LEAVE_OVERLAP');
    });
  });

  it('rejects bad dates, spans across years, and is idempotent on its key', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      expect(
        await err(c, SAM(), `select hr.request_leave($1, date '2027-12-31', date '2028-01-01')`, [
          f.unpaid,
        ]),
      ).toBe('LEAVE_SPANS_YEAR');
      expect(
        await err(c, SAM(), `select hr.request_leave($1, $2::date + 3, $2::date)`, [
          f.unpaid,
          f.monday,
        ]),
      ).toBe('INVALID_DATES');
      const req = `select hr.request_leave($1, $2::date, $2::date, null, 'key-1') as id`;
      const [a] = await as<{ id: string }>(c, SAM(), req, [f.annual, f.monday]);
      const [b] = await as<{ id: string }>(c, SAM(), req, [f.annual, f.monday]);
      expect(b!.id).toBe(a!.id);
      // a user who is not a worker cannot request leave
      expect(await err(c, await newUser(c, ids, 'No Worker'), req, [f.annual, f.monday])).toBe(
        'INVALID_WORKER',
      );
    });
  });

  it('reject and cancel close the request; the balance is untouched', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const { id: l1 } = await first<{ id: string }>(
        c,
        SAM(),
        `select hr.request_leave($1, $2::date, $2::date) as id`,
        [f.annual, f.monday],
      );
      const r1 = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.leave_request where id = $1', [
          l1,
        ])
      ).r;
      await as(c, FLOOR(), `select wf.act($1, 'reject', 'short staffed')`, [r1]);
      await execute(c, r1);
      expect(
        (await one<{ s: string }>(c, 'select status s from hr.leave_request where id = $1', [l1]))
          .s,
      ).toBe('rejected');
      expect(
        (await as<{ kind: string }>(c, SAM(), 'select kind from ops.notification')).map(
          (n) => n.kind,
        ),
      ).toEqual(['leave_rejected']);

      const { id: l2 } = await first<{ id: string }>(
        c,
        SAM(),
        `select hr.request_leave($1, $2::date + 1, $2::date + 1) as id`,
        [f.annual, f.monday],
      );
      const r2 = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.leave_request where id = $1', [
          l2,
        ])
      ).r;
      await as(c, SAM(), `select wf.act($1, 'cancel')`, [r2]);
      await execute(c, r2);
      expect(
        (await one<{ s: string }>(c, 'select status s from hr.leave_request where id = $1', [l2]))
          .s,
      ).toBe('cancelled');
      const used = await one<{ u: string }>(
        c,
        `select used_days u from hr.leave_balance where worker_id = $1 and leave_type_id = $2
            and year = extract(year from $3::date)`,
        [f.sam, f.annual, f.monday],
      );
      expect(used.u).toBe('0.0');
    });
  });

  it("a department head's own leave goes to the outlet manager, theirs to the area manager", async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const requestOf = async (who: string) => {
        const { id } = await first<{ id: string }>(
          c,
          who,
          `select hr.request_leave($1, $2::date, $2::date) as id`,
          [f.annual, f.monday],
        );
        return (
          await one<{ r: string }>(
            c,
            'select wf_request_id r from hr.leave_request where id = $1',
            [id],
          )
        ).r;
      };
      // the floor manager heads Floor Service: their own leave skips to the outlet manager
      const r1 = await requestOf(FLOOR());
      expect(await inbox(c, FLOOR())).not.toContain(r1);
      expect(await inbox(c, OLIVIA())).toContain(r1);
      expect(await err(c, FLOOR(), `select wf.act($1, 'approve')`, [r1])).toBe(
        'SEGREGATION_OF_DUTIES',
      );
      // the Bar Manager works at the outlet: their own leave goes to the area manager
      await c.query('update hr.worker set org_node_id = $2 where id = $1', [
        f.olivia,
        ids.node('TEST-BAR-3.0'),
      ]);
      const r2 = await requestOf(OLIVIA());
      expect(await inbox(c, OLIVIA())).not.toContain(r2);
      expect(await inbox(c, ARIA())).toContain(r2);
    });
  });

  it('self-service RLS: own leave and balances only; managers see their outlet', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      await as(c, SAM(), `select hr.request_leave($1, $2::date, $2::date)`, [f.annual, f.monday]);
      const count = async (user: string, table: string) =>
        (
          await as<{ n: string }>(c, user, `select count(*) n from ${table} where worker_id = $1`, [
            f.sam,
          ])
        )[0]!.n;
      expect(await count(SAM(), 'hr.leave_request')).toBe('1');
      expect(await count(SAM(), 'hr.leave_balance')).not.toBe('0');
      expect(await count(f.pat.userId, 'hr.leave_request')).toBe('0');
      expect(await count(f.pat.userId, 'hr.leave_balance')).toBe('0');
      expect(await count(OLIVIA(), 'hr.leave_request')).toBe('1');
      expect(await count(ARIA(), 'hr.leave_request')).toBe('1');
      expect(await count(f.omar.userId, 'hr.leave_request')).toBe('0');
      // nobody writes leave rows directly
      expect(
        await err(
          c,
          SAM(),
          `update hr.leave_request set status = 'approved' where worker_id = $1`,
          [f.sam],
        ),
      ).toMatch(/permission denied/);
      expect(
        await err(
          c,
          f.pat.userId,
          'select * from hr.leave_conflicts((select id from hr.leave_request limit 1))',
        ),
      ).toBe('NOT_AUTHORISED');
    });
  });
});

// ---------------------------------------------------------------------------
describe('SHIFT_SWAP', () => {
  async function offered(
    c: PoolClient,
    f: Fx,
    from: string,
    fromUser: string,
    to: string,
    role: JobRole = 'SERVER',
  ) {
    const s = await shift(c, f, 1, '09:00', 8, role);
    const a = await assign(c, s, from);
    const { id } = await first<{ id: string }>(
      c,
      fromUser,
      'select hr.request_swap($1, $2) as id',
      [a, to],
    );
    return { shiftId: s, assignmentId: a, swapId: id };
  }

  it('offer -> accept -> module approval -> apply moves the shift', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const { shiftId, assignmentId, swapId } = await offered(c, f, f.sam, SAM(), f.pat.workerId);
      const incoming = await as<{ swap_id: string; direction: string }>(
        c,
        f.pat.userId,
        'select * from hr.my_swaps()',
      );
      expect(incoming.map((s) => [s.swap_id, s.direction])).toEqual([[swapId, 'incoming']]);
      expect(
        (
          await as<{ s: string }>(c, f.pat.userId, 'select hr.respond_swap($1, true) as s', [
            swapId,
          ])
        )[0]!.s,
      ).toBe('submitted');
      const req = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.shift_swap where id = $1', [
          swapId,
        ])
      ).r;
      const r = await one<{ initiator_id: string; excluded_approvers: string[] }>(
        c,
        'select initiator_id, excluded_approvers from wf.request where id = $1',
        [req],
      );
      expect(r.initiator_id).toBe(f.pat.userId);
      expect(r.excluded_approvers).toEqual([SAM()]);
      expect(await inbox(c, FLOOR())).toContain(req);

      // module approval only
      expect(await err(c, FLOOR(), `select wf.act($1, 'approve')`, [req])).toBe(
        'APPROVE_VIA_MODULE',
      );
      expect(
        (await as<{ s: string }>(c, FLOOR(), 'select hr.approve_swap($1) as s', [swapId]))[0]!.s,
      ).toBe('approved');
      await execute(c, req);

      const rows = await c.query<{ worker_id: string; status: string }>(
        'select worker_id, status from hr.shift_assignment where shift_id = $1 order by created_at, id',
        [shiftId],
      );
      expect(rows.rows).toEqual([
        { worker_id: f.sam, status: 'swapped' },
        { worker_id: f.pat.workerId, status: 'assigned' },
      ]);
      expect(
        (
          await one<{ s: string }>(c, 'select status s from hr.shift_assignment where id = $1', [
            assignmentId,
          ])
        ).s,
      ).toBe('swapped');
      for (const u of [SAM(), f.pat.userId]) {
        expect(
          (await as<{ kind: string }>(c, u, 'select kind from ops.notification')).map(
            (n) => n.kind,
          ),
        ).toContain('swap_approved');
      }
    });
  });

  it('neither party approves: a department head swapping goes to the outlet manager', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      // the floor manager and Mia (both rostered as managers in Floor Service) swap
      const floor = await workerFor(
        c,
        ids,
        'test.floor-manager.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        'MANAGER',
      );
      await c.query(`update hr.worker set role_code = 'MANAGER' where id = $1`, [floor]);
      const { swapId } = await offered(c, f, floor, FLOOR(), f.mia.workerId, 'MANAGER');
      await as(c, f.mia.userId, 'select hr.respond_swap($1, true)', [swapId]);
      const req = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.shift_swap where id = $1', [
          swapId,
        ])
      ).r;
      expect(await inbox(c, FLOOR())).not.toContain(req);
      expect(await inbox(c, OLIVIA())).toContain(req);
      expect(await err(c, FLOOR(), 'select hr.approve_swap($1)', [swapId])).toBe(
        'SEGREGATION_OF_DUTIES',
      );
      expect(await err(c, f.mia.userId, 'select hr.approve_swap($1)', [swapId])).toBe(
        'SEGREGATION_OF_DUTIES',
      );
      expect(
        (await as<{ s: string }>(c, OLIVIA(), 'select hr.approve_swap($1) as s', [swapId]))[0]!.s,
      ).toBe('approved');
    });
  });

  it('re-checks the rules at approval and shows the approver the code', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const { swapId } = await offered(c, f, f.sam, SAM(), f.pat.workerId);
      await as(c, f.pat.userId, 'select hr.respond_swap($1, true)', [swapId]);
      // Pat is rostered at 20:00 the evening before: less than 10 h rest before 09:00
      await assign(c, await shift(c, f, 0, '20:00', 4), f.pat.workerId);
      expect(await err(c, FLOOR(), 'select hr.approve_swap($1)', [swapId])).toBe('REST_RULE');
      const req = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.shift_swap where id = $1', [
          swapId,
        ])
      ).r;
      expect(
        (await one<{ s: string }>(c, 'select state s from wf.request where id = $1', [req])).s,
      ).toBe('in_approval');
    });
  });

  it('the executor re-checks as a safety net and fails with the rule code', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const { swapId } = await offered(c, f, f.sam, SAM(), f.pat.workerId);
      await as(c, f.pat.userId, 'select hr.respond_swap($1, true)', [swapId]);
      await as(c, FLOOR(), 'select hr.approve_swap($1)', [swapId]);
      // a conflicting assignment lands between approval and execution
      await assign(c, await shift(c, f, 1, '12:00', 4), f.pat.workerId);
      const req = (
        await one<{ r: string }>(c, 'select wf_request_id r from hr.shift_swap where id = $1', [
          swapId,
        ])
      ).r;
      const ob = (
        await one<{ id: string }>(c, 'select id from wf.outbox where request_id = $1', [req])
      ).id;
      await c.query(`update wf.request set state = 'executing' where id = $1`, [req]);
      await actAs(c, 'wf_executor', null);
      await c.query('savepoint h');
      await expect(c.query(`select hr.execute('hr.shift_swap.apply', $1)`, [req])).rejects.toThrow(
        'SHIFT_OVERLAP',
      );
      await c.query('rollback to savepoint h');
      // what the executor then records for a business-rule code: failed at once, code kept
      const { status } = await one<{ status: string }>(
        c,
        `select wf.record_failure($1, 'SHIFT_OVERLAP', now(), true) as status`,
        [ob],
      );
      await resetRole(c);
      expect(status).toBe('failed');
      const r = await one<{ state: string; failure_code: string }>(
        c,
        'select state, failure_code from wf.request where id = $1',
        [req],
      );
      expect(r).toEqual({ state: 'failed', failure_code: 'SHIFT_OVERLAP' });
      expect(
        (await one<{ a: number }>(c, 'select attempts a from wf.outbox where id = $1', [ob])).a,
      ).toBe(1);
    });
  });

  it('offer checks, decline and withdraw', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const s = await shift(c, f, 1);
      const a = await assign(c, s, f.sam);
      // wrong role partner, and only your own shift
      expect(await err(c, SAM(), 'select hr.request_swap($1, $2)', [a, f.mia.workerId])).toBe(
        'ROLE_MISMATCH',
      );
      expect(await err(c, f.pat.userId, 'select hr.request_swap($1, $2)', [a, f.sam])).toBe(
        'NOT_FOUND',
      );
      const { id } = await first<{ id: string }>(c, SAM(), 'select hr.request_swap($1, $2) as id', [
        a,
        f.pat.workerId,
      ]);
      await as(c, f.pat.userId, 'select hr.respond_swap($1, false)', [id]);
      expect(
        (await as<{ kind: string }>(c, SAM(), 'select kind from ops.notification')).map(
          (n) => n.kind,
        ),
      ).toContain('swap_declined');
      const { id: id2 } = await first<{ id: string }>(
        c,
        SAM(),
        'select hr.request_swap($1, $2) as id',
        [a, f.pat.workerId],
      );
      await as(c, SAM(), 'select hr.withdraw_swap($1)', [id2]);
      expect(await err(c, f.pat.userId, 'select hr.respond_swap($1, true)', [id2])).toBe(
        'INVALID_STATE',
      );
    });
  });

  it('self-service RLS: the owner and managers read the swap; others use hr.my_swaps', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const { swapId } = await offered(c, f, f.sam, SAM(), f.pat.workerId);
      const sees = async (user: string) =>
        (
          await as<{ n: string }>(c, user, 'select count(*) n from hr.shift_swap where id = $1', [
            swapId,
          ])
        )[0]!.n;
      expect(await sees(SAM())).toBe('1');
      expect(await sees(OLIVIA())).toBe('1');
      expect(await sees(f.pat.userId)).toBe('0');
      expect(await sees(ids.user('test.cook.3.0'))).toBe('0');
      expect(await sees(f.omar.userId)).toBe('0');
      expect((await as(c, ids.user('test.cook.3.0'), 'select * from hr.my_swaps()')).length).toBe(
        0,
      );
    });
  });
});

// ---------------------------------------------------------------------------
describe('ROLE_CHANGE', () => {
  const request = `select hr.request_role_change($1, $2, $3, $4, true, $5, $6, $7) as id`;

  it('grant: the Account Owner requests, Security Admin approves, access applies at once', async () => {
    await inRolledBackTx(async (c) => {
      await fixture(c);
      const canAdjust = async () =>
        (
          await as<{ ok: boolean }>(
            c,
            SAM(),
            `select core.can('STOCK_ADJUSTMENTS', 'modify', null, $1) ok`,
            [ids.node('TEST-BAR-3.0-KITCHEN-STORE')],
          )
        )[0]!.ok;
      expect(await canAdjust()).toBe(false);

      const { id } = await first<{ id: string }>(c, OWEN(), request, [
        'grant',
        SAM(),
        'STOCK_USER',
        ids.node('TEST-BAR-3.0-KITCHEN-STORE'),
        null,
        null,
        null,
      ]);
      const rc = await one<{ org_node_id: string; wf_request_id: string }>(
        c,
        'select org_node_id, wf_request_id from hr.role_change where id = $1',
        [id],
      );
      expect(rc.org_node_id).toBe(ids.node('TEST-BAR-3.0-KITCHEN')); // the store's department routes it
      expect(await err(c, OWEN(), `select wf.act($1, 'approve')`, [rc.wf_request_id])).toBe(
        'SEGREGATION_OF_DUTIES',
      );
      expect(await inbox(c, SASHA())).toContain(rc.wf_request_id);
      await as(c, SASHA(), `select wf.act($1, 'approve')`, [rc.wf_request_id]);
      await execute(c, rc.wf_request_id);

      expect(
        (await one<{ s: string }>(c, 'select status s from hr.role_change where id = $1', [id])).s,
      ).toBe('applied');
      expect(await canAdjust()).toBe(true);
      const audit = await one<{ request_id: string }>(
        c,
        `select l.request_id from audit.log l join hr.role_change rc on rc.applied_assignment_id = l.row_id
          where l.table_name = 'core.role_assignment' and l.op = 'INSERT' and rc.id = $1`,
        [id],
      );
      expect(audit.request_id).toBe(rc.wf_request_id);
    });
  });

  it('end: removes access from the end date; the target never approves their own change', async () => {
    await inRolledBackTx(async (c) => {
      await fixture(c);
      const staff = await one<{ id: string }>(
        c,
        `select ra.id from core.role_assignment ra join core.security_group g on g.id = ra.group_id
          where ra.user_id = $1 and g.code = 'STAFF'`,
        [SAM()],
      );
      const { id } = await first<{ id: string }>(c, OWEN(), request, [
        'end',
        null,
        null,
        null,
        null,
        '2026-06-30',
        staff.id,
      ]);
      const rc = await one<{ wf_request_id: string }>(
        c,
        'select wf_request_id from hr.role_change where id = $1',
        [id],
      );
      await as(c, SASHA(), `select wf.act($1, 'approve')`, [rc.wf_request_id]);
      await execute(c, rc.wf_request_id);
      const roster = await as<{ ok: boolean }>(
        c,
        SAM(),
        `select core.can('ROSTER', 'view', $1, null) ok`,
        [ids.node('TEST-BAR-3.0-FLOOR-SERVICE')],
      );
      expect(roster[0]!.ok).toBe(false);

      // a change to Sasha's own access has no other Security Admin to approve it, and the
      // account owner who asked is the top of the chain: approved at once (ADR 010)
      const { id: own } = await first<{ id: string }>(c, OWEN(), request, [
        'grant',
        SASHA(),
        'AUDITOR',
        ids.node('TEST-COMPANY'),
        null,
        null,
        null,
      ]);
      const top = await one<{ state: string; top_of_chain: boolean }>(
        c,
        `select s.state, s.top_of_chain from wf.step_instance s
           join hr.role_change rc on rc.wf_request_id = s.request_id where rc.id = $1`,
        [own],
      );
      expect(top).toEqual({ state: 'approved', top_of_chain: true });
    });
  });

  it('only User Admins and Account Owners request; cross-tenant targets are refused', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      // staff have no user administration
      expect(
        await err(c, SAM(), request, [
          'grant',
          f.pat.userId,
          'STOCK_USER',
          ids.node('TEST-BAR-3.0-KITCHEN-STORE'),
          null,
          null,
          null,
        ]),
      ).toBe('NOT_AUTHORISED');
      const other = (
        await one<{ id: string }>(c, `insert into core.tenant (name) values ('Other') returning id`)
      ).id;
      const node = (
        await one<{ id: string }>(
          c,
          `insert into core.hierarchy_node (tenant_id, type, kind, name) values ($1, 'org', 'company', 'X') returning id`,
          [other],
        )
      ).id;
      expect(await err(c, OWEN(), request, ['grant', SAM(), 'STAFF', node, null, null, null])).toBe(
        'TENANT_MISMATCH',
      );
    });
  });

  it('the role_assignment same-tenant trigger stops a bad subject at execution', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const other = (
        await one<{ id: string }>(c, `insert into core.tenant (name) values ('Other') returning id`)
      ).id;
      const node = (
        await one<{ id: string }>(
          c,
          `insert into core.hierarchy_node (tenant_id, type, kind, name) values ($1, 'org', 'company', 'X') returning id`,
          [other],
        )
      ).id;
      // bypass the hr.role_change guard (as the table owner) to reach the core trigger
      await c.query('alter table hr.role_change disable trigger same_tenant');
      const rc = (
        await one<{ id: string }>(
          c,
          `insert into hr.role_change (tenant_id, org_node_id, action, target_user_id, group_id,
                                       node_id, effective_from, created_by)
           select $1, $2, 'grant', $3, g.id, $4, current_date, $5
             from core.security_group g where g.tenant_id = $1 and g.code = 'STAFF' returning id`,
          [f.tenant, ids.node('TEST-COMPANY'), SAM(), node, OWEN()],
        )
      ).id;
      const { r } = await first<{ r: string }>(
        c,
        OWEN(),
        `select wf.submit('ROLE_CHANGE', 'hr.role_change', $1) r`,
        [rc],
      );
      await c.query(
        `update hr.role_change set status = 'submitted', wf_request_id = $2 where id = $1`,
        [rc, r],
      );
      await c.query('alter table hr.role_change enable trigger same_tenant');
      await as(c, SASHA(), `select wf.act($1, 'approve')`, [r]);
      await c.query(`update wf.request set state = 'executing' where id = $1`, [r]);
      await actAs(c, 'wf_executor', null);
      await c.query('savepoint h');
      await expect(c.query(`select hr.execute('hr.role_change.apply', $1)`, [r])).rejects.toThrow(
        'TENANT_MISMATCH',
      );
      await c.query('rollback to savepoint h');
      await resetRole(c);
    });
  });
});
