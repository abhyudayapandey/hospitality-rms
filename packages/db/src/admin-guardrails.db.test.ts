import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  sqlState,
  type SeedIds,
} from '../test/helpers';

// User administration guardrails (ADR 009, Prompt 7 item 5), one describe per guardrail:
// (a) admin rights are not data access; (b) scope, no self-grants, admin rank; (c) sensitive
// grants through ROLE_CHANGE with the account owner as fallback; (d) the last account owner
// stays; (e) every admin action is audited, and the access audit shows only access events.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const GM1 = 'test.general-manager.1.0'; // USER_ADMIN for Hotel 1.0 (file 08)
const FD2 = 'test.front-desk-executive.2.0'; // USER_ADMIN for the Guest House (file 08)
const OWNER = 'test.account-owner';
const SEC = 'test.security-admin';
const SOLO_OWNER = 'test.solo.bar-manager';

async function call<T = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await attemptAs<T & object>(c, ids.user(who), sql, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows[0] as T;
}

async function error(c: PoolClient, who: string, sql: string, params: unknown[] = []) {
  return (await attemptAs(c, ids.user(who), sql, params)).error;
}

const GRANT = 'select core.grant_access($1, $2, $3) as r';
const grant = (c: PoolClient, who: string, target: string, group: string, place: string) =>
  call<{ r: { status: string; assignment_id?: string; role_change_id?: string } }>(c, who, GRANT, [
    ids.user(target),
    group,
    ids.node(place),
  ]).then((x) => x.r);

async function holds(c: PoolClient, who: string, group: string, place: string): Promise<boolean> {
  const { rows } = await c.query(
    `select 1 from core.role_assignment ra join core.security_group g on g.id = ra.group_id
      where ra.user_id = $1 and g.code = $2 and ra.node_id = $3
        and ra.effective_from <= current_date
        and (ra.effective_to is null or ra.effective_to >= current_date)`,
    [ids.user(who), group, ids.node(place)],
  );
  return rows.length > 0;
}

/** Approves a role change as `who`, then runs its handler like the executor. */
async function approveRoleChange(c: PoolClient, who: string, roleChange: string) {
  const req = (
    await c.query<{ r: string }>('select wf_request_id r from hr.role_change where id = $1', [
      roleChange,
    ])
  ).rows[0]!.r;
  await call(c, who, `select wf.act($1, 'approve')`, [req]);
  const { rows } = await c.query<{ id: string; handler: string }>(
    `select id, handler from wf.outbox where request_id = $1 and status = 'pending'`,
    [req],
  );
  for (const row of rows) {
    await c.query(`update wf.request set state = 'executing' where id = $1`, [req]);
    await actAs(c, 'wf_executor', null);
    await c.query('select hr.execute($1, $2)', [row.handler, req]);
    await resetRole(c);
    await c.query('select wf.complete_outbox($1)', [row.id]);
  }
  return req;
}

describe('(a) admin rights are not data access', () => {
  it('a User Admin grants stock access they cannot use themselves', async () => {
    await inRolledBackTx(async (c) => {
      const r = await grant(
        c,
        FD2,
        'test.steward.2.0',
        'STOCK_USER',
        'TEST-GUEST-HOUSE-2.0-SUPPLY',
      );
      expect(r.status).toBe('applied');
      expect(await holds(c, 'test.steward.2.0', 'STOCK_USER', 'TEST-GUEST-HOUSE-2.0-SUPPLY')).toBe(
        true,
      );
      const can = await call<{ ok: boolean }>(
        c,
        FD2,
        `select core.can('STOCK_LEVELS', 'view', null, $1) as ok`,
        [ids.node('TEST-GUEST-HOUSE-2.0-SUPPLY')],
      );
      expect(can.ok).toBe(false);
      // and no data policy can be attached to an admin group
      expect(
        await sqlState(
          c,
          `insert into core.domain_policy (tenant_id, domain_id, group_id, access)
           select g.tenant_id, d.id, g.id, 'view' from core.security_group g
             join core.domain d on d.tenant_id = g.tenant_id and d.code = 'WORKERS'
            where g.code = 'USER_ADMIN' and g.tenant_id = $1`,
          [ids.tenant()],
        ),
      ).toBe('P0001');
    });
  });
});

describe('(b) scope, no self-grants, admin rank', () => {
  it('only inside your scope, for people inside it, and never for yourself', async () => {
    await inRolledBackTx(async (c) => {
      // a place outside the Guest House
      expect(
        await error(c, FD2, GRANT, [
          ids.user('test.steward.2.0'),
          'STOCK_USER',
          ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'),
        ]),
      ).toBe('NOT_AUTHORISED');
      // a person outside it, at a place inside it
      expect(
        await error(c, FD2, GRANT, [
          ids.user('test.cook.3.0'),
          'STOCK_USER',
          ids.node('TEST-GUEST-HOUSE-2.0-SUPPLY'),
        ]),
      ).toBe('NOT_AUTHORISED');
      expect(
        await error(c, GM1, GRANT, [
          ids.user(GM1),
          'STOCK_USER',
          ids.node('TEST-HOTEL-1.0-BAR-STORE'),
        ]),
      ).toBe('SELF_GRANT');
      // staff administer nobody
      expect(
        await error(c, 'test.bellboy.1.0', GRANT, [
          ids.user('test.bell-captain.1.0'),
          'STAFF',
          ids.node('TEST-HOTEL-1.0-FRONT-OFFICE'),
        ]),
      ).toBe('NOT_AUTHORISED');
    });
  });

  it('a User Admin cannot grant Account Owner nor touch one; granting User Admin needs approval', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        await error(c, GM1, GRANT, [
          ids.user('test.store-manager.1.0'),
          'ACCOUNT_OWNER',
          ids.node('TEST-HOTEL-1.0'),
        ]),
      ).toBe('ABOVE_OWN_RANK');
      // an Account Owner working in Hotel 1.0 is out of the User Admin's reach
      const ra = (
        await c.query<{ id: string }>(
          `insert into core.role_assignment (tenant_id, user_id, group_id, node_id)
           select $1, $2, id, $3 from core.security_group where tenant_id = $1 and code = 'ACCOUNT_OWNER'
           returning id`,
          [ids.tenant(), ids.user('test.bar-manager.1.0'), ids.node('TEST-HOTEL-1.0')],
        )
      ).rows[0]!.id;
      expect(await error(c, GM1, 'select core.revoke_access($1)', [ra])).toBe('ABOVE_OWN_RANK');
      expect(
        await error(c, GM1, `select core.set_user_status($1, 'inactive')`, [
          ids.user('test.bar-manager.1.0'),
        ]),
      ).toBe('ABOVE_OWN_RANK');
      expect(
        await error(c, GM1, GRANT, [
          ids.user('test.bar-manager.1.0'),
          'STOCK_USER',
          ids.node('TEST-HOTEL-1.0-BAR-STORE'),
        ]),
      ).toBe('ABOVE_OWN_RANK');
      // a User Admin within their own scope: a request, not a grant
      const ua = await grant(c, GM1, 'test.hr-executive.1.0', 'USER_ADMIN', 'TEST-HOTEL-1.0');
      expect(ua.status).toBe('pending');
      expect(await holds(c, 'test.hr-executive.1.0', 'USER_ADMIN', 'TEST-HOTEL-1.0')).toBe(false);
    });
  });
});

describe('(c) sensitive grants go through ROLE_CHANGE; everyday grants apply at once', () => {
  it('an outlet manager grant waits for the security admin; a stock user grant does not', async () => {
    await inRolledBackTx(async (c) => {
      const everyday = await grant(
        c,
        GM1,
        'test.receiving-clerk.1.0',
        'STOCK_USER',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
      );
      expect(everyday.status).toBe('applied');

      const r = await grant(c, GM1, 'test.store-manager.1.0', 'OUTLET_MANAGER', 'TEST-HOTEL-1.0');
      expect(r.status).toBe('pending');
      expect(await holds(c, 'test.store-manager.1.0', 'OUTLET_MANAGER', 'TEST-HOTEL-1.0')).toBe(
        false,
      );
      await approveRoleChange(c, SEC, r.role_change_id!);
      expect(await holds(c, 'test.store-manager.1.0', 'OUTLET_MANAGER', 'TEST-HOTEL-1.0')).toBe(
        true,
      );
    });
  });

  it('without a security admin, the account owner approves', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`delete from core.role_assignment where user_id = $1`, [ids.user(SEC)]);
      const r = await grant(c, GM1, 'test.hr-executive.1.0', 'OUTLET_HR', 'TEST-HOTEL-1.0-BAR');
      expect(r.status).toBe('pending');
      await approveRoleChange(c, OWNER, r.role_change_id!);
      expect(await holds(c, 'test.hr-executive.1.0', 'OUTLET_HR', 'TEST-HOTEL-1.0-BAR')).toBe(true);
    });
  });

  it('a sole account owner, whom no one else could approve, grants directly (noted)', async () => {
    await inRolledBackTx(async (c) => {
      const r = await grant(
        c,
        SOLO_OWNER,
        'test.solo.floor-manager',
        'OUTLET_MANAGER',
        'TEST-SOLO-BAR',
      );
      expect(r.status).toBe('applied');
      const note = await c.query<{ n: string }>(
        'select source_note n from core.role_assignment where id = $1',
        [r.assignment_id],
      );
      expect(note.rows[0]!.n).toBe('sole account owner: no one else can approve');
    });
  });

  it('what counts as sensitive', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ code: string }>(
        `select code from core.security_group where tenant_id = $1 and core.is_sensitive_group(id)
          order by code`,
        [ids.tenant()],
      );
      expect(rows.map((r) => r.code)).toEqual([
        'ACCOUNT_OWNER',
        'HR_ADMIN', // also holds COMPENSATION
        'OUTLET_HR',
        'OUTLET_MANAGER',
        'USER_ADMIN',
      ]);
    });
  });

  it('new people get their everyday defaults now and sensitive ones on approval', async () => {
    await inRolledBackTx(async (c) => {
      const commis = await call<{ r: { user_id: string; applied: number; pending: string[] } }>(
        c,
        GM1,
        `select core.create_user('test.new-commis.1.0', 'New Commis', $1, 'COMMIS') as r`,
        [ids.node('TEST-HOTEL-1.0-KITCHEN')],
      );
      expect(commis.r).toMatchObject({ applied: 2, pending: [] }); // STAFF, PRODUCTION_TEAM
      const gm = await call<{ r: { user_id: string; applied: number; pending: string[] } }>(
        c,
        GM1,
        `select core.create_user('test.new-agm.1.0', 'New AGM', $1, 'ASSISTANT_GENERAL_MANAGER') as r`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      expect(gm.r.applied).toBe(0);
      expect(gm.r.pending).toHaveLength(2); // OUTLET_MANAGER at the outlet and its supply point
      expect(
        await error(
          c,
          GM1,
          `select core.create_user('test.new-commis.1.0', 'Again', $1, 'COMMIS')`,
          [ids.node('TEST-HOTEL-1.0-KITCHEN')],
        ),
      ).toBe('USERNAME_TAKEN');
      expect(
        await error(
          c,
          GM1,
          `select core.create_user('test.new-owner', 'Owner', $1, 'ACCOUNT_OWNER')`,
          [ids.node('TEST-HOTEL-1.0')],
        ),
      ).toBe('NOT_AUTHORISED'); // the owner's company-wide default is outside the hotel
      expect(
        await error(c, FD2, `select core.create_user('test.new-cook.1.0', 'Cook', $1, 'COOK')`, [
          ids.node('TEST-HOTEL-1.0-KITCHEN'),
        ]),
      ).toBe('NOT_AUTHORISED');
    });
  });
});

describe('(d) the last account owner stays', () => {
  it('cannot be ended, removed or deactivated; with a second owner, one can go', async () => {
    await inRolledBackTx(async (c) => {
      const owner = ids.user(SOLO_OWNER);
      for (const sql of [
        `update core.role_assignment ra set effective_from = date '2020-01-01',
                effective_to = current_date - 1
           from core.security_group g
          where g.id = ra.group_id and g.code = 'ACCOUNT_OWNER' and ra.user_id = $1`,
        `delete from core.role_assignment ra using core.security_group g
          where g.id = ra.group_id and g.code = 'ACCOUNT_OWNER' and ra.user_id = $1`,
        `update core.app_user set status = 'inactive' where id = $1`,
      ]) {
        await c.query('savepoint s');
        await expect(c.query(sql, [owner])).rejects.toThrow('LAST_ACCOUNT_OWNER');
        await c.query('rollback to savepoint s');
      }
      // nor through the admin functions: the owner cannot act on themselves
      expect(
        await error(c, SOLO_OWNER, `select core.set_user_status($1, 'inactive')`, [owner]),
      ).toBe('SELF_GRANT');
      // Test Company with a second owner: the first can be deactivated
      await c.query(
        `insert into core.role_assignment (tenant_id, user_id, group_id, node_id)
         select $1, $2, id, $3 from core.security_group where tenant_id = $1 and code = 'ACCOUNT_OWNER'`,
        [ids.tenant(), ids.user('test.auditor'), ids.node('TEST-COMPANY')],
      );
      expect(
        (
          await call<{ s: string }>(
            c,
            'test.auditor',
            `select core.set_user_status($1, 'inactive') as s`,
            [ids.user(OWNER)],
          )
        ).s,
      ).toBe('inactive');
    });
  });
});

describe('(e) every admin action is audited; the access audit shows only access events', () => {
  it('grants, people created and deactivated, role changes and approvals, within scope', async () => {
    await inRolledBackTx(async (c) => {
      await grant(c, GM1, 'test.receiving-clerk.1.0', 'STOCK_USER', 'TEST-HOTEL-1.0-KITCHEN-STORE');
      const made = await call<{ r: { user_id: string } }>(
        c,
        GM1,
        `select core.create_user('test.new-commis.1.0', 'New Commis', $1, 'COMMIS') as r`,
        [ids.node('TEST-HOTEL-1.0-KITCHEN')],
      );
      await call(c, GM1, `select core.set_user_status($1, 'inactive')`, [made.r.user_id]);
      const rc = await grant(c, GM1, 'test.store-manager.1.0', 'OUTLET_MANAGER', 'TEST-HOTEL-1.0');
      await approveRoleChange(c, SEC, rc.role_change_id!);
      await grant(c, FD2, 'test.steward.2.0', 'STOCK_USER', 'TEST-GUEST-HOUSE-2.0-SUPPLY');
      // a business write in the same period
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                       unit_cost, ref_type)
         select n.tenant_id, n.item_id, n.delivery_node_id, 'receipt', 1, 1, 'audit-test'
           from inv.item_node n where n.delivery_node_id = $1 limit 1`,
        [ids.node('TEST-HOTEL-1.0-KITCHEN-STORE')],
      );

      type Row = { action: string; person: string | null; actor: string; place: string };
      const audit = async (who: string) =>
        (
          await attemptAs<Row>(
            c,
            ids.user(who),
            'select action, person, actor, place from core.access_audit(500)',
          )
        ).rows ?? [];
      const all = await audit(OWNER);
      const actions = new Set(all.map((r) => r.action));
      for (const a of [
        'granted',
        'user created',
        'user deactivated',
        'role change requested',
        'role change approved by approver',
        'role change applied',
      ]) {
        expect(actions, a).toContain(a);
      }
      expect(all).toContainEqual(
        expect.objectContaining({
          action: 'user deactivated',
          person: 'New Commis',
          actor: 'Test General Manager 1.0',
        }),
      );
      expect(all.some((r) => r.person === 'Test Steward 2.0')).toBe(true);
      // only access events: nothing from the ledger or any other business table
      const allowed =
        /^(granted|removed|ended|changed|user (created|deactivated|reactivated|changed)|role change .*|password reset|login (disabled|enabled)|approved at the top of the chain)$/;
      expect(all.every((r) => allowed.test(r.action))).toBe(true);
      // the Hotel 1.0 User Admin sees the hotel's events, not the Guest House's
      const hotel = await audit(GM1);
      expect(hotel.some((r) => r.person === 'New Commis')).toBe(true);
      expect(hotel.some((r) => r.person === 'Test Steward 2.0')).toBe(false);
      // staff have no access audit
      expect(
        (await attemptAs(c, ids.user('test.bellboy.1.0'), 'select * from core.access_audit()'))
          .error,
      ).toBe('NOT_AUTHORISED');
    });
  });
});
