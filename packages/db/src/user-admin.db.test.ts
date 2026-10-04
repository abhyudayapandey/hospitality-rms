import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  sqlState,
  type SeedIds,
} from '../test/helpers';

// User administration (ADR 011, PRD USR-1..4): the functions behind the admin screens.
// Written before the feature: scope, rank and self rules on every action, previews that
// cannot drift from the real save, audit rows, pool-wide login uniqueness, rate limits.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const GM1 = 'test.general-manager.1.0'; // USER_ADMIN for Hotel 1.0
const FD2 = 'test.front-desk-executive.2.0'; // USER_ADMIN for the Guest House
const OWNER = 'test.account-owner';
const SOLO_OWNER = 'test.solo.bar-manager';
const IN_HOTEL = 'test.bellboy.1.0';
const IN_GUEST_HOUSE = 'test.steward.2.0';

async function ok<T = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T & object>(c, ids.user(who), sql, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}

async function error(c: PoolClient, who: string, sql: string, params: unknown[] = []) {
  return (await attemptAs(c, ids.user(who), sql, params)).error;
}

type Preview = { access_group: string; node_code: string; applies: string };
const PREVIEW = `select access_group, node_code, applies
                   from core.preview_create_user($1, $2, $3, $4) order by 1, 2`;
const CREATE = `select core.create_user($1, $2, $3, $4) as r`;

describe('previews match what saving does', () => {
  it('the derived access of a new person, with now or approval per row', async () => {
    await inRolledBackTx(async (c) => {
      const args = [
        'test.new-agm.1.0',
        'New AGM',
        ids.node('TEST-HOTEL-1.0'),
        'ASSISTANT_GENERAL_MANAGER',
      ];
      const preview = await ok<Preview>(c, GM1, PREVIEW, args);
      expect(preview.length).toBeGreaterThan(0);
      expect(
        preview.filter((p) => p.access_group === 'OUTLET_MANAGER').map((p) => p.applies),
      ).toEqual(['approval', 'approval']);
      // nothing was written by the preview
      const none = await c.query(`select 1 from core.app_user where username = 'test.new-agm.1.0'`);
      expect(none.rows).toEqual([]);

      await ok(c, GM1, CREATE, args);
      const user = (
        await c.query<{ id: string }>(
          `select id from core.app_user where username = 'test.new-agm.1.0'`,
        )
      ).rows[0]!.id;
      const actual = await c.query<Preview>(
        `select g.code as access_group, n.code as node_code, 'now' as applies
           from core.role_assignment ra join core.security_group g on g.id = ra.group_id
           join core.hierarchy_node n on n.id = ra.node_id where ra.user_id = $1
         union all
         select g.code, n.code, 'approval'
           from hr.role_change rc join core.security_group g on g.id = rc.group_id
           join core.hierarchy_node n on n.id = rc.node_id
          where rc.target_user_id = $1 and rc.status = 'submitted'
         order by 1, 2`,
        [user],
      );
      expect(actual.rows).toEqual(preview);
    });
  });

  it('labels a grant: now, approval, or sole owner: now', async () => {
    await inRolledBackTx(async (c) => {
      const grant = 'select core.preview_grant($1, $2, $3) as applies';
      const label = async (who: string, target: string, group: string, place: string) =>
        (
          await ok<{ applies: string }>(c, who, grant, [ids.user(target), group, ids.node(place)])
        )[0]!.applies;
      expect(await label(GM1, IN_HOTEL, 'STOCK_USER', 'TEST-HOTEL-1.0-BAR-STORE')).toBe('now');
      expect(await label(GM1, IN_HOTEL, 'OUTLET_MANAGER', 'TEST-HOTEL-1.0')).toBe('approval');
      expect(await label(SOLO_OWNER, 'test.solo.server', 'OUTLET_MANAGER', 'TEST-SOLO-BAR')).toBe(
        'sole owner: now',
      );
    });
  });
});

describe('every action stays inside the admin’s scope', () => {
  it('Hotel 1.0 and Guest House User Admins: NOT_AUTHORISED on the other’s people', async () => {
    await inRolledBackTx(async (c) => {
      for (const [admin, outsider, place] of [
        [GM1, IN_GUEST_HOUSE, 'TEST-GUEST-HOUSE-2.0'],
        [FD2, IN_HOTEL, 'TEST-HOTEL-1.0-FRONT-OFFICE'],
      ] as const) {
        const target = ids.user(outsider);
        // list: never shown; detail: refused
        const listed = await ok<{ user_id: string }>(
          c,
          admin,
          'select user_id from core.admin_users()',
        );
        expect(
          listed.map((r) => r.user_id),
          admin,
        ).not.toContain(target);
        expect(listed.length, admin).toBeGreaterThan(0);
        for (const sql of [
          ['select * from core.admin_user($1)', [target]],
          [CREATE, ['test.x.' + admin, 'X', ids.node(place), 'STEWARD']],
          [`select core.update_user($1, 'Renamed')`, [target]],
          [`select core.grant_access($1, 'STAFF', $2)`, [target, ids.node(place)]],
          [`select * from core.login_admin_target($1, 'reset_password')`, [target]],
          [`select * from core.login_admin_target($1, 'disable_login')`, [target]],
          [`select core.set_user_status($1, 'inactive')`, [target]],
        ] as const) {
          expect(await error(c, admin, sql[0], [...sql[1]]), `${admin}: ${sql[0]}`).toBe(
            'NOT_AUTHORISED',
          );
        }
      }
    });
  });

  it('staff have no user administration at all', async () => {
    await inRolledBackTx(async (c) => {
      expect(await error(c, IN_HOTEL, 'select * from core.admin_users()')).toBe('NOT_AUTHORISED');
      expect(
        await error(c, IN_HOTEL, `select * from core.login_admin_target($1, 'reset_password')`, [
          ids.user('test.bell-captain.1.0'),
        ]),
      ).toBe('NOT_AUTHORISED');
    });
  });

  it('ABOVE_OWN_RANK and SELF_GRANT on edits and login actions', async () => {
    await inRolledBackTx(async (c) => {
      // an Account Owner working in Hotel 1.0: beyond a User Admin
      await c.query(
        `insert into core.role_assignment (tenant_id, user_id, group_id, node_id)
         select $1, $2, id, $3 from core.security_group where tenant_id = $1 and code = 'ACCOUNT_OWNER'`,
        [ids.tenant(), ids.user('test.bar-manager.1.0'), ids.node('TEST-HOTEL-1.0')],
      );
      const owner = ids.user('test.bar-manager.1.0');
      expect(await error(c, GM1, `select core.update_user($1, 'Renamed')`, [owner])).toBe(
        'ABOVE_OWN_RANK',
      );
      expect(
        await error(c, GM1, `select * from core.login_admin_target($1, 'reset_password')`, [owner]),
      ).toBe('ABOVE_OWN_RANK');
      expect(await error(c, GM1, `select core.update_user($1, 'Me')`, [ids.user(GM1)])).toBe(
        'SELF_GRANT',
      );
      expect(
        await error(c, GM1, `select * from core.login_admin_target($1, 'disable_login')`, [
          ids.user(GM1),
        ]),
      ).toBe('SELF_GRANT');
    });
  });
});

describe('what the admin forms offer', () => {
  it('only places in scope and groups up to the admin’s own rank', async () => {
    await inRolledBackTx(async (c) => {
      const places = (await ok<{ id: string }>(c, GM1, 'select id from core.admin_places()')).map(
        (p) => p.id,
      );
      expect(places).toContain(ids.node('TEST-HOTEL-1.0-KITCHEN'));
      expect(places).not.toContain(ids.node('TEST-GUEST-HOUSE-2.0'));
      const groups = (
        await ok<{ code: string }>(c, GM1, 'select code from core.admin_groups()')
      ).map((g) => g.code);
      expect(groups).toContain('USER_ADMIN');
      expect(groups).not.toContain('ACCOUNT_OWNER');
      expect(groups).not.toContain('SELF');
      const owners = (
        await ok<{ code: string }>(c, OWNER, 'select code from core.admin_groups()')
      ).map((g) => g.code);
      expect(owners).toContain('ACCOUNT_OWNER');
      expect(await error(c, IN_HOTEL, 'select * from core.admin_places()')).toBe('NOT_AUTHORISED');
    });
  });

  // Prompt 10 audit #14: only job roles the admin can give someone at one of their places,
  // by the same checks saving makes (scope of every derived grant, rank).
  const roles = async (c: PoolClient, who: string, home?: string) =>
    (
      await ok<{ code: string }>(
        c,
        who,
        home
          ? 'select code from core.admin_job_roles($1)'
          : 'select code from core.admin_job_roles()',
        home ? [ids.node(home)] : [],
      )
    ).map((r) => r.code);

  it('job roles: only those the admin can assign at their places', async () => {
    await inRolledBackTx(async (c) => {
      const gm = await roles(c, GM1);
      expect(gm).toEqual(expect.arrayContaining(['COMMIS', 'BANQUET_MANAGER', 'GENERAL_MANAGER']));
      for (const out of [
        'ACCOUNT_OWNER',
        'AREA_MANAGER',
        'HR_ADMIN',
        'SECURITY_ADMIN',
        'AUDITOR',
        'CENTRAL_KITCHEN_CHEF',
        'CENTRAL_KITCHEN_MANAGER',
      ]) {
        expect(gm, out).not.toContain(out);
      }
      const all = await c.query<{ code: string }>(
        `select distinct code from hr.job_role where tenant_id = $1 and archived_at is null order by 1`,
        [ids.tenant()],
      );
      expect((await roles(c, OWNER)).sort()).toEqual(all.rows.map((r) => r.code).sort());
      expect((await roles(c, SOLO_OWNER)).length).toBe(8);
      // a home place narrows it: a kitchen role, not one that needs the outlet's bar
      const guestHouse = await roles(c, FD2);
      expect(guestHouse).toContain('COOK');
      expect(guestHouse).not.toContain('FANDB_MANAGER');
      expect(await error(c, IN_HOTEL, 'select * from core.admin_job_roles()')).toBe(
        'NOT_AUTHORISED',
      );
      expect(
        await error(c, GM1, 'select * from core.admin_job_roles($1)', [
          ids.node('TEST-GUEST-HOUSE-2.0'),
        ]),
      ).toBe('NOT_AUTHORISED');
    });
  });

  it('job roles offered = roles a real save accepts at some place in scope', async () => {
    await inRolledBackTx(async (c) => {
      const offered = new Set(await roles(c, FD2));
      const homes = (
        await ok<{ id: string; type: string }>(c, FD2, 'select id, type from core.admin_places()')
      ).filter((p) => p.type === 'org');
      const all = await c.query<{ code: string }>(
        `select distinct code from hr.job_role where tenant_id = $1 and archived_at is null`,
        [ids.tenant()],
      );
      const mismatches: string[] = [];
      for (const { code } of all.rows) {
        let saves = false;
        for (const h of homes) {
          const r = await attemptAs(c, ids.user(FD2), PREVIEW, ['probe.user', 'Probe', h.id, code]);
          if (!r.error) {
            saves = true;
            break;
          }
        }
        if (saves !== offered.has(code)) mismatches.push(`${code}: saves ${saves}`);
      }
      expect(mismatches).toEqual([]);
    });
  });
});

describe('edits and login actions', () => {
  it('update_user renames and moves a person, re-deriving their access', async () => {
    await inRolledBackTx(async (c) => {
      const target = ids.user(IN_HOTEL);
      await ok(
        c,
        GM1,
        `select core.update_user($1, 'Test Bellboy Renamed', null, null, 'BELL_CAPTAIN')`,
        [target],
      );
      const w = await c.query<{ role_code: string; name: string }>(
        `select w.role_code, u.display_name as name from hr.worker w
           join core.app_user u on u.id = w.owner_user_id where u.id = $1`,
        [target],
      );
      expect(w.rows[0]).toEqual({ role_code: 'BELL_CAPTAIN', name: 'Test Bellboy Renamed' });
      const derived = await c.query<{ n: number }>(
        `select count(*)::int n from core.derive_job_role_access($1) d
          where not exists (select 1 from core.role_assignment ra
                              join core.security_group g on g.id = ra.group_id
                             where ra.user_id = $1 and g.code = d.access_group and ra.node_id = d.node_id)
            and not exists (select 1 from hr.role_change rc
                              join core.security_group g on g.id = rc.group_id
                             where rc.target_user_id = $1 and g.code = d.access_group
                               and rc.status = 'submitted')`,
        [target],
      );
      expect(derived.rows[0]!.n).toBe(0);
    });
  });

  it('a password reset is for username logins only, returns the login and is audited', async () => {
    await inRolledBackTx(async (c) => {
      const [t] = await ok<{ username: string; login_type: string }>(
        c,
        GM1,
        `select username, login_type from core.login_admin_target($1, 'reset_password')`,
        [ids.user(IN_HOTEL)],
      );
      expect(t).toEqual({ username: 'test.bellboy.1.0', login_type: 'username' });
      await c.query(
        `update core.app_user set login_type = 'email', email = 'bb@example.test'
                      where id = $1`,
        [ids.user('test.bell-captain.1.0')],
      );
      expect(
        await error(c, GM1, `select * from core.login_admin_target($1, 'reset_password')`, [
          ids.user('test.bell-captain.1.0'),
        ]),
      ).toBe('INVALID_ACTION');
      await ok(c, GM1, `select core.set_user_status($1, 'inactive')`, [ids.user(IN_HOTEL)]);
      await ok(c, GM1, `select * from core.login_admin_target($1, 'disable_login')`, [
        ids.user(IN_HOTEL),
      ]);
      await ok(c, GM1, `select core.update_user($1, 'Test Bell Captain Renamed')`, [
        ids.user('test.bell-captain.1.0'),
      ]);
      const audit = await ok<{ action: string; person: string }>(
        c,
        OWNER,
        'select action, person from core.access_audit(50)',
      );
      for (const action of [
        'password reset',
        'login disabled',
        'user deactivated',
        'user changed',
      ]) {
        expect(
          audit.map((a) => a.action),
          action,
        ).toContain(action);
      }
    });
  });

  it('link_login records the Cognito account once; sign-ins are timestamped', async () => {
    await inRolledBackTx(async (c) => {
      const target = ids.user(IN_HOTEL);
      await c.query('update core.app_user set cognito_sub = null where id = $1', [target]);
      await ok(c, GM1, 'select core.link_login($1, $2)', [target, 'sub-bellboy']);
      await ok(c, GM1, 'select core.link_login($1, $2)', [target, 'sub-bellboy']); // idempotent
      expect(await error(c, GM1, 'select core.link_login($1, $2)', [target, 'sub-other'])).toBe(
        'INVALID_STATE',
      );
      await ok(c, IN_HOTEL, 'select core.record_sign_in()');
      const r = await c.query<{ at: Date | null }>(
        'select last_sign_in_at as at from core.app_user where id = $1',
        [target],
      );
      expect(r.rows[0]!.at).not.toBeNull();
    });
  });
});

describe('logins are unique across all customers (one Cognito pool)', () => {
  it('USERNAME_TAKEN and EMAIL_TAKEN across customers; the index backs it up', async () => {
    await inRolledBackTx(async (c) => {
      // the solo owner creating someone with a Test Company username or email
      await c.query(`update core.app_user set email = 'taken@example.test' where id = $1`, [
        ids.user(IN_HOTEL),
      ]);
      const create = `select core.create_user($1, 'Someone', $2, 'SERVER', $3, $4) as r`;
      expect(
        await error(c, SOLO_OWNER, create, [
          'test.bellboy.1.0',
          ids.node('TEST-SOLO-BAR-FLOOR-SERVICE'),
          'username',
          null,
        ]),
      ).toBe('USERNAME_TAKEN');
      expect(
        await error(c, SOLO_OWNER, create, [
          'test.solo.someone',
          ids.node('TEST-SOLO-BAR-FLOOR-SERVICE'),
          'email',
          'TAKEN@example.test',
        ]),
      ).toBe('EMAIL_TAKEN');
      expect(
        await sqlState(
          c,
          `insert into core.app_user (tenant_id, kind, display_name, username)
           values ($1, 'human', 'Clash', 'test.bellboy.1.0')`,
          [ids.tenant('TEST-SOLO-COMPANY')],
        ),
      ).toBe('23505');
    });
  });

  it('username suggestions start with the customer code and avoid taken ones', async () => {
    await inRolledBackTx(async (c) => {
      const suggest = 'select core.suggest_username($1) as u';
      const [a] = await ok<{ u: string }>(c, GM1, suggest, ['Ravi Kumar']);
      expect(a!.u).toBe('test-company.ravi.k');
      await c.query(
        `insert into core.app_user (tenant_id, kind, display_name, username)
         values ($1, 'human', 'Ravi Kumar', 'test-company.ravi.k')`,
        [ids.tenant()],
      );
      const [b] = await ok<{ u: string }>(c, GM1, suggest, ['Ravi Kumar']);
      expect(b!.u).toBe('test-company.ravi.k2');
      const [solo] = await ok<{ u: string }>(c, SOLO_OWNER, suggest, ['Ravi Kumar']);
      expect(solo!.u).toBe('test-solo-company.ravi.k');
    });
  });
});

describe('rate limits live in Postgres', () => {
  it('allows up to the limit per key and window, then refuses', async () => {
    await inRolledBackTx(async (c) => {
      const hit = async (key: string) =>
        (await c.query<{ ok: boolean }>(`select core.rate_limit_hit($1, 3, 60) as ok`, [key]))
          .rows[0]!.ok;
      expect([await hit('login:ip:1'), await hit('login:ip:1'), await hit('login:ip:1')]).toEqual([
        true,
        true,
        true,
      ]);
      expect(await hit('login:ip:1')).toBe(false);
      expect(await hit('login:ip:2')).toBe(true);
      // the app role may call it (before sign-in there is no user)
      expect(
        (await attemptAs(c, '', `select core.rate_limit_hit('login:ip:3', 3, 60)`)).error,
      ).toBeUndefined();
    });
  });
});
