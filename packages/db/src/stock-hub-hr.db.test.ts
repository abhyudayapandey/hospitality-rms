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

// UX-4, UX-5 and SW-4 (ADR 035), security first.
// - Swaps for management only (SW-4): a company setting, on by default (Test Company's file
//   00 turns it off so its staff swap with each other). When on, only someone who changes
//   the roster at the shift's place may offer a swap.
// - Company settings: swaps_managers_only and count_due_days, only by the Account Owner.
// - Deactivation through approval (UX-5): anyone holding WORKERS modify where the person
//   works (HR, and now the outlet manager) asks; the security admin approves; the person
//   becomes inactive. Never oneself, never another company, never with WORKERS view only.
// - Team → People and Leave: hr.team_people and hr.team_leave list a place's people and
//   their leave for those who see worker records (and leave) there, and nothing else.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const FLOOR = 'TEST-BAR-3.0-FLOOR-SERVICE';

async function err(c: PoolClient, user: string, sql: string, params: unknown[] = []) {
  return (await attemptAs(c, ids.user(user), sql, params)).error;
}

async function rows<T extends object>(
  c: PoolClient,
  user: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T>(c, ids.user(user), sql, params);
  if (r.error !== undefined) throw new Error(`${sql}: ${r.error}`);
  return r.rows;
}

async function workerOf(c: PoolClient, username: string): Promise<string> {
  const r = await c.query<{ id: string }>(
    `select w.id from hr.worker w where w.owner_user_id = $1`,
    [ids.user(username)],
  );
  return r.rows[0]!.id;
}

/** A published shift at Floor Service in three weeks, with `who` assigned to it. */
async function assignedShift(c: PoolClient, who: string, role: string): Promise<string> {
  const s = await c.query<{ id: string }>(
    `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code,
                           headcount, status, published_at)
     select $1, $2, d, (d + time '09:00') at time zone 'Asia/Kolkata',
            (d + time '17:00') at time zone 'Asia/Kolkata', $3, 1, 'published', now()
       from (select current_date + 21 as d) x
     returning id`,
    [ids.tenant(), ids.node(FLOOR), role],
  );
  const a = await c.query<{ id: string }>(
    `insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                      start_at, end_at, status)
     select s.tenant_id, s.id, w.id, w.owner_user_id, s.org_node_id, s.start_at, s.end_at,
            'assigned'
       from hr.shift s, hr.worker w where s.id = $1 and w.id = $2
     returning id`,
    [s.rows[0]!.id, await workerOf(c, who)],
  );
  return a.rows[0]!.id;
}

const setSwapsManagersOnly = (c: PoolClient, on: boolean | null) =>
  c.query(
    on === null
      ? `update core.tenant set settings = settings - 'swaps_managers_only' where id = $1`
      : `update core.tenant set settings = settings || jsonb_build_object('swaps_managers_only', $2::boolean) where id = $1`,
    on === null ? [ids.tenant()] : [ids.tenant(), on],
  );

describe('swaps for management only (SW-4)', () => {
  it('is on by default; Test Company turns it off in file 00', async () => {
    await inRolledBackTx(async (c) => {
      const read = async () =>
        (
          await rows<{ on: boolean }>(
            c,
            'test.server.3.0',
            `select (core.company_settings() ->> 'swaps_managers_only')::boolean as on`,
          )
        )[0]!.on;
      expect(await read()).toBe(false);
      await setSwapsManagersOnly(c, null);
      expect(await read()).toBe(true);
    });
  });

  it('when on, a server cannot offer a swap; when off, they can', async () => {
    await inRolledBackTx(async (c) => {
      const a = await assignedShift(c, 'test.server.3.0', 'SERVER');
      const colleague = await workerOf(c, 'test.server-b.3.0');
      await setSwapsManagersOnly(c, true);
      expect(
        await err(c, 'test.server.3.0', 'select hr.request_swap($1, $2)', [a, colleague]),
      ).toBe('SWAPS_MANAGERS_ONLY');
      // the default (no setting) is the same
      await setSwapsManagersOnly(c, null);
      expect(
        await err(c, 'test.server.3.0', 'select hr.request_swap($1, $2)', [a, colleague]),
      ).toBe('SWAPS_MANAGERS_ONLY');
      await setSwapsManagersOnly(c, false);
      expect(
        await err(c, 'test.server.3.0', 'select hr.request_swap($1, $2)', [a, colleague]),
      ).toBeUndefined();
    });
  });

  it('when on, someone who changes the roster there may still offer one', async () => {
    await inRolledBackTx(async (c) => {
      const a = await assignedShift(c, 'test.floor-manager.3.0', 'FLOOR_MANAGER');
      await setSwapsManagersOnly(c, true);
      const e = await err(c, 'test.floor-manager.3.0', 'select hr.request_swap($1, $2)', [
        a,
        await workerOf(c, 'test.server.3.0'),
      ]);
      // whatever the rostering rules say about the colleague, it is not this rule
      expect(e ?? '').not.toBe('SWAPS_MANAGERS_ONLY');
    });
  });
});

describe('company settings (UX-4, SW-4)', () => {
  it('the Account Owner sets them; values are checked; nobody else may', async () => {
    await inRolledBackTx(async (c) => {
      const set = (user: string, v: unknown) =>
        err(c, user, 'select core.set_company_settings($1::jsonb)', [JSON.stringify(v)]);
      expect(
        await set('test.account-owner', { swaps_managers_only: true, count_due_days: 10 }),
      ).toBeUndefined();
      const s = (
        await rows<{ s: { swaps_managers_only: boolean; count_due_days: number } }>(
          c,
          'test.server.3.0',
          'select core.company_settings() as s',
        )
      )[0]!.s;
      expect(s.swaps_managers_only).toBe(true);
      expect(s.count_due_days).toBe(10);
      for (const bad of [
        { count_due_days: 0 },
        { count_due_days: 61 },
        { count_due_days: 2.5 },
        { count_due_days: '7' },
        { swaps_managers_only: 'yes' },
      ]) {
        expect(await set('test.account-owner', bad), JSON.stringify(bad)).toBe('INVALID_SETTING');
      }
      expect(await set('test.general-manager.1.0', { count_due_days: 3 })).toBe('NOT_AUTHORISED');
    });
  });

  it('a new company counts every 7 days', async () => {
    await inRolledBackTx(async (c) => {
      const r = await c.query<{ d: number }>(
        `select (core.settings_defaults() ->> 'count_due_days')::int as d`,
      );
      expect(r.rows[0]!.d).toBe(7);
    });
  });
});

/** Runs the request's outbox rows through hr.execute as wf_executor. */
async function execute(c: PoolClient, requestId: string): Promise<void> {
  const { rows: out } = await c.query<{ id: string; handler: string }>(
    `select id, handler from wf.outbox where request_id = $1 and status = 'pending'`,
    [requestId],
  );
  for (const row of out) {
    await c.query(
      `update wf.request set state = 'executing' where id = $1 and state in ('approved', 'rejected')`,
      [requestId],
    );
    await actAs(c, 'wf_executor', null);
    await c.query('select hr.execute($1, $2)', [row.handler, requestId]);
    await resetRole(c);
    await c.query('select wf.complete_outbox($1)', [row.id]);
  }
}

const requestFor = async (c: PoolClient, deactivation: string) =>
  (
    await c.query<{ r: string }>(`select wf_request_id as r from hr.deactivation where id = $1`, [
      deactivation,
    ])
  ).rows[0]!.r;

describe('deactivation through approval (UX-5)', () => {
  it('HR asks, the security admin approves, the person is inactive', async () => {
    await inRolledBackTx(async (c) => {
      const commis = ids.user('test.commis.1.0');
      const [d] = await rows<{ id: string }>(
        c,
        'test.hr-executive.1.0',
        'select hr.request_deactivation($1, $2) as id',
        [commis, 'Left the company'],
      );
      const req = await requestFor(c, d!.id);
      const inbox = async (u: string) =>
        (await rows<{ request_id: string }>(c, u, 'select request_id from wf.my_inbox()')).map(
          (r) => r.request_id,
        );
      expect(await inbox('test.security-admin')).toContain(req);
      expect(await inbox('test.commis.1.0')).not.toContain(req);
      // a second request for the same person waits for the first
      expect(
        await err(c, 'test.general-manager.1.0', 'select hr.request_deactivation($1, $2)', [
          commis,
          'again',
        ]),
      ).toBe('INVALID_STATE');
      await rows(c, 'test.security-admin', `select wf.act($1, 'approve')`, [req]);
      await execute(c, req);
      const after = await c.query<{ u: string; w: string; d: string }>(
        `select u.status as u, w.status as w, d.status as d
           from core.app_user u join hr.worker w on w.owner_user_id = u.id
           join hr.deactivation d on d.target_user_id = u.id
          where u.id = $1`,
        [commis],
      );
      expect(after.rows[0]).toEqual({ u: 'inactive', w: 'inactive', d: 'applied' });
      // the requester is told
      const told = await c.query(
        `select 1 from ops.notification where owner_user_id = $1 and kind = 'deactivation_applied'`,
        [ids.user('test.hr-executive.1.0')],
      );
      expect(told.rowCount).toBe(1);
    });
  });

  it('a rejection leaves the person active', async () => {
    await inRolledBackTx(async (c) => {
      const [d] = await rows<{ id: string }>(
        c,
        'test.general-manager.1.0',
        'select hr.request_deactivation($1, $2) as id',
        [ids.user('test.steward.1.0'), 'Contract ended'],
      );
      const req = await requestFor(c, d!.id);
      await rows(c, 'test.security-admin', `select wf.act($1, 'reject', 'not yet')`, [req]);
      await execute(c, req);
      const r = await c.query<{ s: string }>(
        `select status as s from core.app_user where id = $1`,
        [ids.user('test.steward.1.0')],
      );
      expect(r.rows[0]!.s).toBe('active');
    });
  });

  it('only with WORKERS modify where the person works; never oneself or another company', async () => {
    await inRolledBackTx(async (c) => {
      const ask = (who: string, target: string, reason = 'x') =>
        err(c, who, 'select hr.request_deactivation($1, $2)', [ids.user(target), reason]);
      // WORKERS view only: the executive chef, the area manager
      expect(await ask('test.executive-chef.1.0', 'test.commis.1.0')).toBe('NOT_AUTHORISED');
      expect(await ask('test.area-manager', 'test.commis.1.0')).toBe('NOT_AUTHORISED');
      expect(await ask('test.server.3.0', 'test.host.3.0')).toBe('NOT_AUTHORISED');
      // HR of another outlet
      expect(await ask('test.hr-executive.1.0', 'test.commis.1.1')).toBe('NOT_AUTHORISED');
      // another company
      expect(await ask('test.solo.bar-manager', 'test.commis.1.0')).toBe('NOT_AUTHORISED');
      expect(await ask('test.hr-executive.1.0', 'test.solo.bar-manager')).toBe('NOT_AUTHORISED');
      // never oneself; a reason is needed
      expect(await ask('test.general-manager.1.0', 'test.general-manager.1.0')).toBe('SELF_GRANT');
      expect(await ask('test.hr-executive.1.0', 'test.commis.1.0', '  ')).toBe('REASON_REQUIRED');
      // and nobody writes the table directly
      const direct = await attemptAs(
        c,
        ids.user('test.hr-executive.1.0'),
        `insert into hr.deactivation (tenant_id, org_node_id, target_user_id, worker_id, reason)
         select w.tenant_id, w.org_node_id, w.owner_user_id, w.id, 'x' from hr.worker w
          where w.owner_user_id = $1`,
        [ids.user('test.commis.1.0')],
      );
      expect(direct.error).toBeDefined();
    });
  });
});

interface PersonRow {
  user_id: string;
  username: string;
  place: string;
  can_deactivate: boolean;
}

describe('Team → People and Leave (UX-5)', () => {
  it('people at the place and below, for those who see worker records there', async () => {
    await inRolledBackTx(async (c) => {
      const people = await rows<PersonRow>(
        c,
        'test.hr-executive.1.0',
        'select * from hr.team_people($1)',
        [ids.node('TEST-HOTEL-1.0')],
      );
      // an independent count: every worker whose home is Hotel 1.0 or below
      const expected = await c.query<{ n: number }>(
        `select count(*)::int as n from hr.worker w
           join core.hierarchy_node n on n.id = w.org_node_id
           join core.hierarchy_node o on o.code = 'TEST-HOTEL-1.0'
          where n.path operator(extensions.<@) o.path`,
      );
      expect(people.length).toBe(expected.rows[0]!.n);
      expect(people.map((p) => p.username)).toContain('test.commis.1.0');
      expect(people.map((p) => p.username)).not.toContain('test.commis.1.1');
      // HR may ask to deactivate anyone there but themselves
      expect(people.find((p) => p.username === 'test.commis.1.0')!.can_deactivate).toBe(true);
      expect(people.find((p) => p.username === 'test.hr-executive.1.0')!.can_deactivate).toBe(
        false,
      );
      // the executive chef sees the Kitchen's people, with no deactivation
      const chef = await rows<PersonRow>(
        c,
        'test.executive-chef.1.0',
        'select * from hr.team_people($1)',
        [ids.node('TEST-HOTEL-1.0-KITCHEN')],
      );
      expect(chef.length).toBeGreaterThan(1);
      expect(chef.every((p) => !p.can_deactivate)).toBe(true);
      expect(chef.every((p) => p.place.includes('Kitchen'))).toBe(true);
    });
  });

  it('refuses places outside what the person sees', async () => {
    await inRolledBackTx(async (c) => {
      const q = 'select * from hr.team_people($1)';
      expect(await err(c, 'test.server.3.0', q, [ids.node(FLOOR)])).toBe('NOT_AUTHORISED');
      expect(await err(c, 'test.hr-executive.1.0', q, [ids.node('TEST-HOTEL-1.1')])).toBe(
        'NOT_AUTHORISED',
      );
      expect(await err(c, 'test.executive-chef.1.0', q, [ids.node('TEST-HOTEL-1.0')])).toBe(
        'NOT_AUTHORISED',
      );
      expect(await err(c, 'test.solo.bar-manager', q, [ids.node('TEST-HOTEL-1.0')])).toBe(
        'NOT_AUTHORISED',
      );
      const l = 'select * from hr.team_leave($1, current_date, current_date + 30)';
      expect(await err(c, 'test.server.3.0', l, [ids.node(FLOOR)])).toBe('NOT_AUTHORISED');
      expect(await err(c, 'test.solo.bar-manager', l, [ids.node('TEST-HOTEL-1.0')])).toBe(
        'NOT_AUTHORISED',
      );
      expect(
        await err(
          c,
          'test.hr-executive.1.0',
          'select * from hr.team_leave($1, current_date, current_date + 100)',
          [ids.node('TEST-HOTEL-1.0')],
        ),
      ).toBe('INVALID_DATES');
    });
  });

  it('leave at the place: waiting and approved, in the period', async () => {
    await inRolledBackTx(async (c) => {
      const type = await c.query<{ id: string }>(
        `select t.id from hr.leave_type t where t.tenant_id = $1 and t.code = 'UNPAID_LEAVE'`,
        [ids.tenant()],
      );
      await rows(
        c,
        'test.steward.1.0',
        'select hr.request_leave($1, current_date + 40, current_date + 41, $2)',
        [type.rows[0]!.id, 'family'],
      );
      const seen = await rows<{ name: string; status: string; days: string }>(
        c,
        'test.hr-executive.1.0',
        'select * from hr.team_leave($1, current_date + 30, current_date + 60)',
        [ids.node('TEST-HOTEL-1.0')],
      );
      const mine = seen.filter((r) => r.name === 'Test Steward 1.0');
      expect(mine.map((r) => [r.status, Number(r.days)])).toEqual([['submitted', 2]]);
      // the GM sees it too (LEAVE view); the server's colleague at another outlet does not
      expect(
        (
          await rows<{ name: string }>(
            c,
            'test.general-manager.1.0',
            'select * from hr.team_leave($1, current_date + 30, current_date + 60)',
            [ids.node('TEST-HOTEL-1.0')],
          )
        ).some((r) => r.name === 'Test Steward 1.0'),
      ).toBe(true);
    });
  });
});
