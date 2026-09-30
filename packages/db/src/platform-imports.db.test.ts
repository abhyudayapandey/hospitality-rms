import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asPlatform,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  newPlatformAdmin,
  resetRole,
  sqlState,
  type SeedIds,
} from '../test/helpers';

// Imports and logins in the Platform Admin console (ADR 013), written before the feature.
// An upload belongs to one customer: its storage key is under that customer and its file 00
// names that customer. Applying needs a successful dry run of the same upload, and only the
// worker (platform_loader) runs jobs. The Test<Role>!12 option is refused in SQL for a
// customer that is not a test customer. Logins are only ever linked to that customer's
// people (never the AI agent), every step is in the platform audit, and email invites are
// counted against the pool's daily allowance.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const TEST = () => ids.tenant('TEST-COMPANY');
const SOLO = () => ids.tenant('TEST-SOLO-COMPANY');
const upload = (tenant: string, over: Record<string, unknown> = {}) => ({
  key: `onboarding/${tenant}/0192d6a0-0000-7000-8000-000000000001.json`,
  name: 'test-company.zip',
  bytes: 12345,
  sha256: 'a'.repeat(64),
  files: ['00_customer.csv', '07_users.csv'],
  customer_code: 'TEST-COMPANY',
  ...over,
});

async function nonTestCustomer(c: PoolClient): Promise<string> {
  const t = (
    await c.query<{ id: string }>(
      `insert into core.tenant (name, code, is_test) values ('Acme Hotels', 'ACME', false)
       returning id`,
    )
  ).rows[0]!.id;
  await c.query(
    `insert into core.app_user (tenant_id, kind, display_name, username, login_type)
     values ($1, 'human', 'Ravi K', 'acme.ravi.k', 'username')`,
    [t],
  );
  return t;
}

async function asLoader<T extends object>(c: PoolClient, sql: string, params: unknown[] = []) {
  await c.query('set local role platform_loader');
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await resetRole(c);
  }
}

/** Claims `job` as the worker would (other queued jobs, e.g. from e2e, are set aside). */
async function claim(c: PoolClient, job: string): Promise<string[]> {
  await c.query(`update platform.job set status = 'done' where status = 'queued' and id <> $1`, [
    job,
  ]);
  return (await asLoader<{ id: string }>(c, 'select id from platform.claim_job()')).map(
    (j) => j.id,
  );
}

async function finishDryRun(c: PoolClient, job: string, ok: boolean): Promise<void> {
  expect(await claim(c, job)).toEqual([job]);
  await asLoader(c, 'select platform.finish_job($1, null, $2, $3)', [
    job,
    ok ? { ok: true, counts: {} } : null,
    ok ? null : '07_users.csv:3 unknown job role',
  ]);
}

describe('customers cannot use imports or logins', () => {
  it('NOT_AUTHORISED on every new platform function, even for an account owner', async () => {
    await inRolledBackTx(async (c) => {
      const owner = ids.user('test.account-owner');
      const tenant = TEST();
      for (const [sql, params] of [
        ['select * from platform.customer($1)', [tenant]],
        ['select * from platform.job($1)', [tenant]],
        ['select platform.request_import($1, $2::jsonb)', [tenant, JSON.stringify(upload(tenant))]],
        ['select platform.request_import_apply($1)', [tenant]],
        ['select * from platform.login_candidates($1)', [tenant]],
        ['select * from platform.begin_logins($1, false)', [tenant]],
        ['select platform.link_customer_login($1, $2)', [owner, 'sub-x']],
        ['select platform.request_invites($1)', [tenant]],
        ['select * from platform.invite_status($1)', [tenant]],
      ] as const) {
        expect((await attemptAs(c, owner, sql, [...params])).error, sql).toBe('NOT_AUTHORISED');
      }
    });
  });

  it('only the worker runs jobs: app_rw cannot claim, finish, defer or record invites', async () => {
    await inRolledBackTx(async (c) => {
      for (const sql of [
        'select * from platform.claim_job()',
        `select platform.finish_job(gen_random_uuid(), null, null, null)`,
        `select platform.defer_job(gen_random_uuid(), now(), null)`,
        `select platform.record_invite(gen_random_uuid(), gen_random_uuid(), 'sub')`,
        'select * from platform.invite_allowance()',
        'select * from platform.invite',
        `insert into platform.job (kind, payload) values ('import_apply', '{}')`,
      ]) {
        await c.query('set local role app_rw');
        expect(await sqlState(c, sql), sql).toBe('42501');
        await resetRole(c);
      }
    });
  });
});

describe('an upload belongs to one customer', () => {
  it('its key must be under that customer, and its file 00 must name that customer', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const req = (tenant: string, u: object) =>
        asPlatform(c, admin, 'select platform.request_import($1, $2::jsonb) as id', [
          tenant,
          JSON.stringify(u),
        ]);
      // another customer's prefix, a path escape, not our layout
      for (const key of [
        `onboarding/${SOLO()}/0192d6a0-0000-7000-8000-000000000001.json`,
        `onboarding/${TEST()}/../${SOLO()}/x.json`,
        `wastage/${TEST()}/x.json`,
      ]) {
        expect((await req(TEST(), upload(TEST(), { key }))).error, key).toBe('INVALID_UPLOAD');
      }
      // file 00 names a different customer
      expect((await req(SOLO(), upload(SOLO()))).error).toBe('CUSTOMER_MISMATCH');

      const ok = await req(TEST(), upload(TEST()));
      expect(ok.error).toBeUndefined();
      const job = (ok.rows![0] as { id: string }).id;
      const row = await c.query<{ kind: string; tenant_id: string; status: string }>(
        'select kind, tenant_id, status from platform.job where id = $1',
        [job],
      );
      expect(row.rows).toEqual([{ kind: 'import_dry_run', tenant_id: TEST(), status: 'queued' }]);
      const audit = await c.query<{ detail: Record<string, unknown> }>(
        `select detail from platform.audit_event where action = 'import_uploaded' and tenant_id = $1
            and at = now()`,
        [TEST()],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.detail).toMatchObject({
        job,
        name: 'test-company.zip',
        bytes: 12345,
        sha256: 'a'.repeat(64),
      });
    });
  });

  it('applying needs a successful dry run of the same upload', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const dry = async () =>
        (
          (
            await asPlatform(c, admin, 'select platform.request_import($1, $2::jsonb) as id', [
              TEST(),
              JSON.stringify(upload(TEST())),
            ])
          ).rows![0] as { id: string }
        ).id;
      const apply = (job: string) =>
        asPlatform(c, admin, 'select platform.request_import_apply($1) as id', [job]);

      const queued = await dry();
      expect((await apply(queued)).error).toBe('INVALID_STATE'); // not run yet
      await finishDryRun(c, queued, false);
      expect((await apply(queued)).error).toBe('INVALID_STATE'); // failed

      const good = await dry();
      await finishDryRun(c, good, true);
      const applied = await apply(good);
      expect(applied.error).toBeUndefined();
      const job = (applied.rows![0] as { id: string }).id;
      const rows = await c.query<{ kind: string; tenant_id: string; key: string; dry_run: string }>(
        `select kind, tenant_id, payload ->> 'key' as key, payload ->> 'dry_run' as dry_run
           from platform.job where id = $1`,
        [job],
      );
      expect(rows.rows).toEqual([
        { kind: 'import_apply', tenant_id: TEST(), key: upload(TEST()).key, dry_run: good },
      ]);
      // an apply job cannot itself be applied
      expect((await apply(job)).error).toBe('INVALID_STATE');
      const audit = await c.query<{ n: number }>(
        `select count(*)::int as n from platform.audit_event
          where action = 'import_apply_requested' and tenant_id = $1 and at = now()`,
        [TEST()],
      );
      expect(audit.rows).toEqual([{ n: 1 }]);
    });
  });
});

describe('the Test<Role>!12 option', () => {
  it('is refused for a customer that is not a test customer', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const acme = await nonTestCustomer(c);
      await c.query(`update core.app_user set cognito_sub = null where tenant_id = $1`, [SOLO()]);
      const begin = (tenant: string, rule: boolean) =>
        asPlatform<{ username: string; job_title: string | null }>(
          c,
          admin,
          'select username, job_title from platform.begin_logins($1, $2) order by username',
          [tenant, rule],
        );
      expect((await begin(acme, true)).error).toBe('TEST_RULE_NOT_ALLOWED');
      // generated passwords are fine for anyone
      expect((await begin(acme, false)).rows).toEqual([
        { username: 'acme.ravi.k', job_title: null },
      ]);
      // a test customer may use it; each person comes with their job title
      const solo = await begin(SOLO(), true);
      expect(solo.error).toBeUndefined();
      expect(solo.rows).toContainEqual({
        username: 'test.solo.bar-manager',
        job_title: 'Bar Manager',
      });
      const audit = await c.query<{ detail: { test_rule: boolean; count: number } }>(
        `select detail from platform.audit_event where action = 'logins_started' and at = now()
          order by tenant_id = $1 desc`,
        [SOLO()],
      );
      expect(audit.rows[0]!.detail).toMatchObject({ test_rule: true, count: solo.rows!.length });
    });
  });

  it('logins are not created for a suspended customer', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      await asPlatform(c, admin, `select platform.suspend($1, 'unpaid')`, [SOLO()]);
      expect(
        (await asPlatform(c, admin, 'select * from platform.begin_logins($1, false)', [SOLO()]))
          .error,
      ).toBe('CUSTOMER_SUSPENDED');
    });
  });
});

describe('linking a login', () => {
  it('only to one of that customer’s people with a username login and no other login', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const link = (user: string, sub: string) =>
        asPlatform(c, admin, 'select platform.link_customer_login($1, $2)', [user, sub]);
      const agent = (
        await c.query<{ id: string }>(
          `select id from core.app_user where tenant_id = $1 and kind = 'service' limit 1`,
          [SOLO()],
        )
      ).rows[0]!.id;
      expect((await link(agent, 'sub-agent')).error).toBe('INVALID_STATE');

      const bar = ids.user('test.solo.bar-manager');
      await c.query(`update core.app_user set cognito_sub = 'someone-else' where id = $1`, [bar]);
      expect((await link(bar, 'sub-bar')).error).toBe('INVALID_STATE');

      const floor = ids.user('test.solo.floor-manager');
      await c.query(`update core.app_user set cognito_sub = null where id = $1`, [floor]);
      expect((await link(floor, 'sub-floor')).error).toBeUndefined();
      expect((await link(floor, 'sub-floor')).error).toBeUndefined(); // retry: same login
      const row = await c.query('select cognito_sub from core.app_user where id = $1', [floor]);
      expect(row.rows).toEqual([{ cognito_sub: 'sub-floor' }]);
      const audit = await c.query<{ detail: Record<string, unknown> }>(
        `select detail from platform.audit_event where action = 'login_created' and at = now()`,
      );
      expect(audit.rows.map((a) => a.detail)).toEqual([
        { user: floor, username: 'test.solo.floor-manager' },
        { user: floor, username: 'test.solo.floor-manager' },
      ]);
    });
  });
});

describe('email invites', () => {
  it('one job per customer at a time, counted against the daily allowance, run when due', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const t = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name, code, is_test) values ('Mail Co', 'MAIL-CO', false)
           returning id`,
        )
      ).rows[0]!.id;
      const users: string[] = [];
      for (const n of [1, 2, 3]) {
        users.push(
          (
            await c.query<{ id: string }>(
              `insert into core.app_user (tenant_id, kind, display_name, username, email, login_type)
               values ($1, 'human', $2, $3, $4, 'email') returning id`,
              [t, `Person ${n}`, `mail-co.person.${n}`, `person${n}@mail-co.example`],
            )
          ).rows[0]!.id,
        );
      }
      const request = async () =>
        (
          (await asPlatform(c, admin, 'select platform.request_invites($1) as id', [t]))
            .rows![0] as {
            id: string | null;
          }
        ).id;
      const job = (await request())!;
      expect(job).toBeTruthy();
      expect(await request()).toBe(job); // the queued job, not a second one

      const status = async () =>
        (await asPlatform(c, admin, 'select * from platform.invite_status($1)', [t])).rows![0] as {
          waiting: number;
          invited: number;
          daily_limit: number;
        };
      expect(await status()).toMatchObject({ waiting: 3, invited: 0, daily_limit: 40 });

      const before = (
        await asLoader<{ remaining: number }>(c, 'select * from platform.invite_allowance()')
      )[0]!.remaining;
      expect(await claim(c, job)).toEqual([job]);
      await asLoader(c, 'select platform.record_invite($1, $2, $3)', [job, users[0], 'sub-1']);
      const after = (
        await asLoader<{ remaining: number }>(c, 'select * from platform.invite_allowance()')
      )[0]!.remaining;
      expect(after).toBe(before - 1);
      expect(await status()).toMatchObject({ waiting: 2, invited: 1 });

      // the rest waits for tomorrow's allowance: not claimable before then
      await asLoader(c, `select platform.defer_job($1, now() + interval '1 day', $2)`, [
        job,
        { sent: 1, waiting: 2 },
      ]);
      expect(await claim(c, job)).toEqual([]);
      await c.query(
        `update platform.job set run_after = now() - interval '1 second' where id = $1`,
        [job],
      );
      expect(await claim(c, job)).toEqual([job]);

      const audit = await c.query<{ action: string }>(
        `select action from platform.audit_event where tenant_id = $1 and at = now() order by id`,
        [t],
      );
      expect(audit.rows.map((a) => a.action)).toEqual(['invites_requested', 'invite_logins_batch']);
    });
  });
});

describe('the first account owner (ADR 013)', () => {
  it('may be a username login with no email, matching the owner in the customer’s file 07', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const request = (owner: Record<string, unknown>, code = 'ACME') =>
        asPlatform<{ id: string }>(
          c,
          admin,
          'select platform.request_create_customer($1::jsonb) as id',
          [JSON.stringify({ code, name: 'Acme Hotels', is_test: true, owner })],
        );
      // a username owner: no email, and a username that is not taken anywhere
      const ok = await request({
        display_name: 'Ravi K',
        login_type: 'username',
        username: 'Acme.Ravi.K',
      });
      expect(ok.error).toBeUndefined();
      const job = await c.query<{ owner: Record<string, unknown> }>(
        `select payload -> 'owner' as owner from platform.job where id = $1`,
        [ok.rows![0]!.id],
      );
      expect(job.rows[0]!.owner).toEqual({
        display_name: 'Ravi K',
        login_type: 'username',
        username: 'acme.ravi.k',
        email: null,
      });

      // the default username is <code>.owner; an email owner still needs an email
      for (const [owner, error] of [
        [
          { display_name: 'X', login_type: 'username', email: 'x@acme.example' },
          'INVALID_CUSTOMER',
        ],
        [{ display_name: 'X', login_type: 'email' }, 'INVALID_CUSTOMER'],
        [{ display_name: 'X', login_type: 'username', username: 'Bad Name!' }, 'INVALID_CUSTOMER'],
        [{ display_name: 'X', login_type: 'sms', username: 'acme.x' }, 'INVALID_CUSTOMER'],
        // usernames are unique across customers (one Cognito pool)
        [
          { display_name: 'X', login_type: 'username', username: 'test.account-owner' },
          'USERNAME_TAKEN',
        ],
        // ...and across customers still being created
        [{ display_name: 'X', login_type: 'username', username: 'acme.ravi.k' }, 'USERNAME_TAKEN'],
      ] as const) {
        expect((await request(owner, 'ACME-2')).error, JSON.stringify(owner)).toBe(error);
      }
    });
  });
});
