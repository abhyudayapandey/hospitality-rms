import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Customer-specific access groups (AC-1, ADR 027). A company builds its own group from the
// product's business domains, and may let it carry the request and approval duties of
// product roles ("approves like a Department Head"). Only the Account Owner (in the app) or
// a platform admin (file 05) builds them; one company's groups never reach another; admin
// rights can't be put in one; a group that includes a sensitive right, or carries a
// sensitive role's duties, needs approval to grant; a group someone holds can't be removed.
// The test data has Test Company's KITCHEN_LEAD (file 05), held by Sous Chef 1.1 at Hotel
// 1.1's kitchen (file 08), carrying Department Head duties.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const OWNER = 'test.account-owner';
const save = (
  c: PoolClient,
  who: string,
  code: string,
  rights: Record<string, string>,
  actsAs: string[] = [],
  name = code,
) =>
  attemptAs<{ id: string }>(
    c,
    ids.user(who),
    'select core.save_custom_group($1, $2, $3, $4) as id',
    [code, name, JSON.stringify(rights), actsAs],
  );

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

const can = async (c: PoolClient, who: string, domain: string, access: string, node: string) =>
  (
    await as<{ v: boolean }>(c, who, 'select core.can($1, $2, $3, null) as v', [
      domain,
      access,
      ids.node(node),
    ])
  )[0]!.v;

const sensitive = async (c: PoolClient, tenant: string, code: string) =>
  (
    await c.query<{ s: boolean }>(
      `select core.is_sensitive_group(g.id) as s from core.security_group g
        where g.tenant_id = $1 and g.code = $2`,
      [tenant, code],
    )
  ).rows[0]!.s;

describe('building a custom group', () => {
  it('the Account Owner builds one; given to someone, its rights apply there', async () => {
    await inRolledBackTx(async (c) => {
      const r = await save(
        c,
        OWNER,
        'BAR_LEAD',
        { ROSTER: 'modify', TASKS: 'modify' },
        [],
        'Bar lead',
      );
      expect(r.error).toBeUndefined();
      const who = 'test.bartender.1.0';
      expect(await can(c, who, 'ROSTER', 'modify', 'TEST-HOTEL-1.0-BAR')).toBe(false);
      await as(c, OWNER, `select core.grant_access($1, 'BAR_LEAD', $2)`, [
        ids.user(who),
        ids.node('TEST-HOTEL-1.0-BAR'),
      ]);
      expect(await can(c, who, 'ROSTER', 'modify', 'TEST-HOTEL-1.0-BAR')).toBe(true);
      // only where it was given
      expect(await can(c, who, 'ROSTER', 'modify', 'TEST-HOTEL-1.0-KITCHEN')).toBe(false);
      // a second save edits it: the rights follow
      expect((await save(c, OWNER, 'BAR_LEAD', { TASKS: 'modify' })).error).toBeUndefined();
      expect(await can(c, who, 'ROSTER', 'modify', 'TEST-HOTEL-1.0-BAR')).toBe(false);
      expect(await can(c, who, 'TASKS', 'modify', 'TEST-HOTEL-1.0-BAR')).toBe(true);
    });
  });

  it('nobody else may: general manager, user admin, HR admin, security admin, staff', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [
        'test.general-manager.1.0',
        'test.front-desk-executive.2.0',
        'test.hr-admin',
        'test.security-admin',
        'test.server.3.0',
      ]) {
        expect((await save(c, who, 'BAR_LEAD', { TASKS: 'view' })).error, who).toMatch(
          /NOT_AUTHORISED/,
        );
      }
    });
  });

  it('admin rights, company reports, unknown rights and product codes are refused', async () => {
    await inRolledBackTx(async (c) => {
      for (const d of [
        'USER_ACCESS',
        'COMPANY_SETTINGS',
        'SECURITY_ROLES',
        'WF_CONFIG',
        'REPORTS',
      ]) {
        expect((await save(c, OWNER, 'X_GROUP', { [d]: 'view' })).error, d).toMatch(
          /INVALID_GROUP/,
        );
      }
      expect((await save(c, OWNER, 'X_GROUP', { NO_SUCH: 'view' })).error).toMatch(/INVALID_GROUP/);
      expect((await save(c, OWNER, 'X_GROUP', { TASKS: 'admin' })).error).toMatch(/INVALID_GROUP/);
      expect((await save(c, OWNER, 'X_GROUP', {})).error).toMatch(/INVALID_GROUP/);
      expect((await save(c, OWNER, 'bad code', { TASKS: 'view' })).error).toMatch(/INVALID_GROUP/);
      for (const code of ['STAFF', 'OUTLET_MANAGER', 'ACCOUNT_OWNER', 'SELF']) {
        expect((await save(c, OWNER, code, { TASKS: 'view' })).error, code).toMatch(
          /GROUP_CODE_TAKEN/,
        );
      }
    });
  });

  it('can carry the duties of business roles only, never admin or security roles', async () => {
    await inRolledBackTx(async (c) => {
      for (const role of [
        'ACCOUNT_OWNER',
        'USER_ADMIN',
        'SECURITY_ADMIN',
        'AUDITOR',
        'AI_AGENT',
        'SELF',
        'NO_SUCH',
      ]) {
        expect((await save(c, OWNER, 'X_GROUP', { TASKS: 'view' }, [role])).error, role).toMatch(
          /INVALID_GROUP/,
        );
      }
      expect((await save(c, OWNER, 'X_GROUP', { TASKS: 'view' }, ['STORE_KEEPER'])).error).toBe(
        undefined,
      );
    });
  });
});

describe("one company's groups never reach another", () => {
  it('the same code is a separate group; the other company cannot see, change or grant it', async () => {
    await inRolledBackTx(async (c) => {
      expect((await save(c, OWNER, 'BAR_LEAD', { TASKS: 'modify' })).error).toBeUndefined();
      // the solo owner's BAR_LEAD is their own
      expect((await save(c, 'test.solo.bar-manager', 'BAR_LEAD', { ROSTER: 'view' })).error).toBe(
        undefined,
      );
      const groups = await c.query<{ tenant: string; rights: string }>(
        `select t.code as tenant, string_agg(d.code || ':' || dp.access, ',') as rights
           from core.security_group g join core.tenant t on t.id = g.tenant_id
           join core.domain_policy dp on dp.group_id = g.id join core.domain d on d.id = dp.domain_id
          where g.code = 'BAR_LEAD' group by t.code order by t.code`,
      );
      expect(groups.rows).toEqual([
        { tenant: 'TEST-COMPANY', rights: 'TASKS:modify' },
        { tenant: 'TEST-SOLO-COMPANY', rights: 'ROSTER:view' },
      ]);
      const listed = await as<{ code: string }>(
        c,
        'test.solo.bar-manager',
        'select code from core.custom_groups()',
      );
      expect(listed.map((g) => g.code)).toEqual(['BAR_LEAD']);
      const kl = await as<{ code: string }>(
        c,
        'test.solo.bar-manager',
        `select code from core.custom_groups() where code = 'KITCHEN_LEAD'`,
      );
      expect(kl).toEqual([]);
      // a Test Company admin granting "KITCHEN_LEAD" to a solo person: not their person
      const r = await attemptAs(
        c,
        ids.user(OWNER),
        `select core.grant_access($1, 'KITCHEN_LEAD', $2)`,
        [ids.user('test.solo.server'), ids.node('TEST-SOLO-BAR')],
      );
      expect(r.error).toBeDefined();
    });
  });
});

describe('sensitive custom groups need approval to grant', () => {
  it('pay, or a sensitive role’s duties, make a group sensitive; Kitchen lead is not', async () => {
    await inRolledBackTx(async (c) => {
      const t = ids.tenant();
      expect(await sensitive(c, t, 'KITCHEN_LEAD')).toBe(false);
      await save(c, OWNER, 'PAY_VIEW', { COMPENSATION: 'view' });
      expect(await sensitive(c, t, 'PAY_VIEW')).toBe(true);
      await save(c, OWNER, 'DEPUTY_GM', { TASKS: 'view' }, ['OUTLET_MANAGER']);
      expect(await sensitive(c, t, 'DEPUTY_GM')).toBe(true);
      // a right only sensitive product groups hold at that level
      await save(c, OWNER, 'PEOPLE_EDIT', { WORKERS: 'modify' });
      expect(await sensitive(c, t, 'PEOPLE_EDIT')).toBe(true);

      // the GM (a user admin) granting it: it waits for approval
      const r = await as<{ r: { applies: string } }>(
        c,
        'test.general-manager.1.0',
        `select core.grant_access($1, 'PAY_VIEW', $2) as r`,
        [ids.user('test.steward.1.0'), ids.node('TEST-HOTEL-1.0')],
      );
      expect(JSON.stringify(r[0]!.r)).toMatch(/approval|pending/i);
    });
  });
});

describe('a custom group carries the approvals of the role it stands in for', () => {
  async function leave(c: PoolClient, who: string): Promise<string> {
    const type = (
      await c.query<{ id: string }>(
        `select id from hr.leave_type where tenant_id = $1 and code = 'UNPAID_LEAVE'`,
        [ids.tenant()],
      )
    ).rows[0]!.id;
    const [row] = await as<{ id: string }>(
      c,
      who,
      'select hr.request_leave($1, current_date + 70, current_date + 70) as id',
      [type],
    );
    return (
      await c.query<{ r: string }>('select wf_request_id r from hr.leave_request where id = $1', [
        row!.id,
      ])
    ).rows[0]!.r;
  }
  const inbox = async (c: PoolClient, who: string) =>
    (await as<{ request_id: string }>(c, who, 'select request_id from wf.my_inbox()')).map(
      (r) => r.request_id,
    );

  it("Kitchen lead (Sous Chef 1.1) approves the 1.1 kitchen's leave, like its department head", async () => {
    await inRolledBackTx(async (c) => {
      const r = await leave(c, 'test.commis.1.1');
      expect(await inbox(c, 'test.sous-chef.1.1')).toContain(r);
      expect(await inbox(c, 'test.executive-chef.1.1')).toContain(r);
      await as(c, 'test.sous-chef.1.1', `select wf.act($1, 'approve')`, [r]);
      const step = await c.query<{ state: string; actor: string }>(
        `select s.state, s.actor_id::text as actor from wf.step_instance s
          where s.request_id = $1 and s.step = 'manager_approval'`,
        [r],
      );
      expect(step.rows[0]).toEqual({ state: 'approved', actor: ids.user('test.sous-chef.1.1') });
    });
  });

  it('only where it was given, and never their own request', async () => {
    await inRolledBackTx(async (c) => {
      const other = await leave(c, 'test.commis.1.0');
      expect(await inbox(c, 'test.sous-chef.1.1')).not.toContain(other);
      const own = await leave(c, 'test.sous-chef.1.1');
      expect(await inbox(c, 'test.sous-chef.1.1')).not.toContain(own);
      expect(await inbox(c, 'test.executive-chef.1.1')).toContain(own);
    });
  });
});

describe('editing and removing', () => {
  it('every change is audited, by the person who made it', async () => {
    await inRolledBackTx(async (c) => {
      await save(c, OWNER, 'BAR_LEAD', { TASKS: 'view' });
      await save(c, OWNER, 'BAR_LEAD', { TASKS: 'modify' });
      const { rows } = await c.query<{ t: string; actor: string }>(
        `select table_name as t, actor_id::text as actor from audit.log
          where occurred_at >= now() and table_name in ('core.security_group', 'core.domain_policy')
          order by occurred_at`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(new Set(rows.map((r) => r.actor))).toEqual(new Set([ids.user(OWNER)]));
    });
  });

  it('a group someone holds cannot be removed; an unused one can, and its rights go', async () => {
    await inRolledBackTx(async (c) => {
      const held = await attemptAs(
        c,
        ids.user(OWNER),
        `select core.archive_custom_group('KITCHEN_LEAD')`,
      );
      expect(held.error).toMatch(/GROUP_IN_USE/);
      await save(c, OWNER, 'BAR_LEAD', { TASKS: 'modify' });
      expect(
        (await attemptAs(c, ids.user(OWNER), `select core.archive_custom_group('BAR_LEAD')`)).error,
      ).toBeUndefined();
      const left = await c.query<{ n: number }>(
        `select count(*)::int as n from core.domain_policy dp join core.security_group g on g.id = dp.group_id
          where g.tenant_id = $1 and g.code = 'BAR_LEAD'`,
        [ids.tenant()],
      );
      expect(left.rows[0]!.n).toBe(0);
      const grant = await attemptAs(
        c,
        ids.user(OWNER),
        `select core.grant_access($1, 'BAR_LEAD', $2)`,
        [ids.user('test.bartender.1.0'), ids.node('TEST-HOTEL-1.0-BAR')],
      );
      expect(grant.error).toBeDefined();
      // and others can't remove groups
      expect(
        (
          await attemptAs(
            c,
            ids.user('test.general-manager.1.0'),
            `select core.archive_custom_group('KITCHEN_LEAD')`,
          )
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('the app cannot write groups or their rights directly', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user(OWNER),
        `insert into core.security_group (tenant_id, code, name, kind) values ($1, 'SNEAKY', 'x', 'custom')`,
        [ids.tenant()],
      );
      expect(r.error).toMatch(/permission denied|row-level security/);
    });
  });
});
