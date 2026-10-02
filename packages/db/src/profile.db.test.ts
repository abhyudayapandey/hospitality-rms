import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The profile screen (Prompt 11a, ADR 018). Everything here is about the caller: none of
// these functions takes a user, so nobody can read or act on someone else's profile.
//  * core.my_profile / core.my_access: your own details and grants, read-only.
//  * core.record_own_password_change: audits a change made in Cognito (username logins only).
//  * core.sign_out_everywhere: ends every app session (sessions_valid_from) and audits it;
//    the server then signs the person out of Cognito everywhere.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function ok<T extends object>(
  c: PoolClient,
  user: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T>(c, ids.user(user), sql, params);
  if (r.error !== undefined) throw new Error(`${user}: ${r.error}`);
  return r.rows;
}

async function error(c: PoolClient, user: string, sql: string, params: unknown[] = []) {
  return (await attemptAs(c, ids.user(user), sql, params)).error;
}

describe('core.my_profile and core.my_access: your own, read-only', () => {
  it('shows your name, login, job role and home place', async () => {
    await inRolledBackTx(async (c) => {
      const [p] = await ok(c, 'test.commis.1.0', 'select * from core.my_profile()');
      expect(p).toMatchObject({
        display_name: 'Test Commis 1.0',
        username: 'test.commis.1.0',
        login_type: 'username',
        job_role: 'Commis',
        home_place: 'Test Hotel & Bar 1.0 – Kitchen',
      });
    });
  });

  it('lists your own grants with the domains each gives, and SELF for yourself', async () => {
    await inRolledBackTx(async (c) => {
      const rows = await ok<{
        access_group: string;
        place: string | null;
        include_descendants: boolean | null;
        domains: { domain: string; access: string }[];
      }>(c, 'test.general-manager.1.0', 'select * from core.my_access()');
      const gm = rows.find((r) => r.access_group === 'OUTLET_MANAGER' && r.place?.endsWith('1.0'));
      expect(gm).toMatchObject({ place: 'Test Hotel & Bar 1.0', include_descendants: true });
      expect(gm!.domains).toContainEqual({ domain: 'ATTENDANCE', access: 'modify' });
      const self = rows.find((r) => r.access_group === 'SELF');
      expect(self).toMatchObject({ place: null });
      expect(self!.domains).toContainEqual({ domain: 'LEAVE', access: 'modify' });
      // nobody else's grants
      const commis = await ok<{ access_group: string }>(
        c,
        'test.commis.1.0',
        'select access_group from core.my_access()',
      );
      expect(commis.map((r) => r.access_group)).not.toContain('OUTLET_MANAGER');
    });
  });

  it('no session, no profile; app_rw cannot change login fields directly', async () => {
    await inRolledBackTx(async (c) => {
      const anon = await attemptAs(c, '', 'select * from core.my_profile()');
      expect(anon.rows ?? []).toEqual([]);
      expect(
        await error(
          c,
          'test.commis.1.0',
          `update core.app_user set sessions_valid_from = now() where id = $1`,
          [ids.user('test.commis.1.0')],
        ),
      ).toMatch(/permission denied/);
      expect(
        await error(
          c,
          'test.commis.1.0',
          `insert into core.login_admin_event (tenant_id, user_id, action)
           values ($1, $2, 'sign_out_everywhere')`,
          [ids.tenant(), ids.user('test.commis-b.1.0')],
        ),
      ).toMatch(/permission denied/);
    });
  });
});

describe('own login actions', () => {
  it('sign out everywhere ends every session from now, returns the Cognito login, is audited', async () => {
    await inRolledBackTx(async (c) => {
      const before = await ok<{ t: string | null }>(
        c,
        'test.commis.1.0',
        'select core.my_sessions_valid_from() as t',
      );
      expect(before[0]!.t).toBeNull();
      const [r] = await ok<{ username: string }>(
        c,
        'test.commis.1.0',
        'select * from core.sign_out_everywhere()',
      );
      expect(r).toMatchObject({ username: 'test.commis.1.0' });
      const after = await c.query<{ ok: boolean }>(
        `select sessions_valid_from = now() as ok from core.app_user where id = $1`,
        [ids.user('test.commis.1.0')],
      );
      expect(after.rows[0]!.ok).toBe(true);
      // only the caller: the second commis keeps their sessions
      const other = await c.query<{ t: Date | null }>(
        `select sessions_valid_from as t from core.app_user where id = $1`,
        [ids.user('test.commis-b.1.0')],
      );
      expect(other.rows[0]!.t).toBeNull();
      const audit = await ok<{ action: string; person: string; actor: string }>(
        c,
        'test.account-owner',
        'select action, person, actor from core.access_audit(20)',
      );
      expect(audit).toContainEqual({
        action: 'signed out of all devices',
        person: 'Test Commis 1.0',
        actor: 'Test Commis 1.0',
      });
    });
  });

  it('a password change is recorded for username logins only, success or failure', async () => {
    await inRolledBackTx(async (c) => {
      await ok(c, 'test.commis.1.0', 'select core.record_own_password_change(false)');
      await ok(c, 'test.commis.1.0', 'select core.record_own_password_change(true)');
      const audit = await ok<{ action: string; person: string }>(
        c,
        'test.account-owner',
        'select action, person from core.access_audit(20)',
      );
      const mine = audit.filter((a) => a.person === 'Test Commis 1.0').map((a) => a.action);
      expect(mine.sort()).toEqual(['password change failed', 'password changed']);
      await c.query(
        `update core.app_user set login_type = 'email', email = 'commis-b@example.test'
          where id = $1`,
        [ids.user('test.commis-b.1.0')],
      );
      expect(
        await error(c, 'test.commis-b.1.0', 'select core.record_own_password_change(true)'),
      ).toBe('INVALID_ACTION');
    });
  });

  it('the Hotel 1.0 user admin sees their staff’s login actions; Guest House 2.0’s does not', async () => {
    await inRolledBackTx(async (c) => {
      await ok(c, 'test.commis.1.0', 'select * from core.sign_out_everywhere()');
      const seen = async (user: string) =>
        (await ok<{ person: string }>(c, user, 'select person from core.access_audit(20)')).some(
          (a) => a.person === 'Test Commis 1.0',
        );
      expect(await seen('test.general-manager.1.0')).toBe(true);
      expect(await seen('test.front-desk-executive.2.0')).toBe(false);
    });
  });
});
