import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createCustomer, type NewCustomer } from './create';
import { runNextJob } from './worker';

// Creating a customer from the console (ADR 012), as the worker does it: as
// platform_loader, through the job queue, idempotent.

afterAll(closePools);

const ACME: NewCustomer = {
  code: 'ACME',
  name: 'Acme Hotels, Pvt',
  country: 'India',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  isTest: false,
  owner: { displayName: 'Asha Rao', email: 'Asha@Acme.example' },
};

async function asLoader<T>(c: PoolClient, fn: () => Promise<T>): Promise<T> {
  await c.query('set local role platform_loader');
  try {
    return await fn();
  } finally {
    await c.query('reset role');
  }
}

describe('createCustomer (as platform_loader)', () => {
  it('creates the root, the owner with ACCOUNT_OWNER, the AI agent; a second run changes nothing', async () => {
    await inRolledBackTx(async (c) => {
      const first = await asLoader(c, () => createCustomer(c, ACME, { nested: true }));
      expect(first.report.issues).toEqual([]);
      expect(first.report.applied).toBe(true);
      expect(first.ownerUsername).toBe('acme.owner');

      const { rows } = await c.query<{ grp: string; node: string; user: string }>(
        `select g.code as grp, n.code as node, u.username as user
           from core.role_assignment ra join core.security_group g on g.id = ra.group_id
           join core.hierarchy_node n on n.id = ra.node_id join core.app_user u on u.id = ra.user_id
          where ra.tenant_id = $1 order by 1`,
        [first.tenantId],
      );
      expect(rows).toEqual([
        { grp: 'ACCOUNT_OWNER', node: 'ACME', user: 'acme.owner' },
        { grp: 'AI_AGENT', node: 'ACME', user: 'ai-agent' },
      ]);
      const owner = await c.query<{ email: string; login_type: string }>(
        `select email, login_type from core.app_user where username = 'acme.owner'`,
      );
      expect(owner.rows[0]).toEqual({ email: 'asha@acme.example', login_type: 'email' });
      const t = await c.query<{ is_test: boolean; status: string }>(
        'select is_test, status from core.tenant where id = $1',
        [first.tenantId],
      );
      expect(t.rows[0]).toEqual({ is_test: false, status: 'active' });

      const again = await asLoader(c, () => createCustomer(c, ACME, { nested: true }));
      expect(again.report.ok).toBe(true);
      for (const [entity, n] of Object.entries(again.report.counts)) {
        expect(n.created + n.updated, entity).toBe(0);
      }
    });
  });

  it('cannot change is_test afterwards', async () => {
    await inRolledBackTx(async (c) => {
      await asLoader(c, () => createCustomer(c, ACME, { nested: true }));
      const r = await asLoader(c, () =>
        createCustomer(c, { ...ACME, isTest: true }, { nested: true }),
      );
      expect(r.report.ok).toBe(false);
      expect(r.report.issues).toContainEqual({
        file: '00_customer.csv',
        row: 2,
        column: 'is_test',
        message:
          'this customer was created with is_test = no, which cannot change (IS_TEST_IMMUTABLE)',
      });
    });
  });
});

describe('the worker runs queued jobs', () => {
  it('create_customer: queued by a platform admin, run as platform_loader, owner linked', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('set local role app_rw');
      const admin = (
        await c.query<{ id: string }>(
          `select platform.sign_in('sub-worker', 'ops@example.test') as id`,
        )
      ).rows[0]!.id;
      const job = (
        await c.query<{ id: string }>('select platform.request_create_customer($1::jsonb) as id', [
          JSON.stringify({
            code: 'acme',
            name: 'Acme Hotels',
            is_test: true,
            owner: { display_name: 'Asha Rao', email: 'asha@acme.example' },
          }),
        ])
      ).rows[0]!.id;
      await c.query('reset role');

      // nested: the worker's loader runs inside this test's transaction
      const ran = await asLoader(c, async () => {
        await c.query('savepoint worker');
        const id = await runNextJobNested(c);
        await c.query('release savepoint worker');
        return id;
      });
      expect(ran).toBe(job);

      await c.query('set local role app_rw');
      await c.query(`select set_config('app.platform_admin_id', $1, true)`, [admin]);
      const [done] = (
        await c.query<{
          status: string;
          customer_code: string;
          result: { owner_username: string };
        }>('select status, customer_code, result from platform.jobs() where id = $1', [job])
      ).rows;
      expect(done).toMatchObject({ status: 'done', customer_code: 'ACME' });
      expect(done!.result.owner_username).toBe('acme.owner');
      await c.query('select platform.link_owner_login($1, $2)', [job, 'owner-sub']);
      const customers = await c.query<{ code: string; is_test: boolean; user_count: number }>(
        `select code, is_test, user_count from platform.customers() where code = 'ACME'`,
      );
      expect(customers.rows).toEqual([{ code: 'ACME', is_test: true, user_count: 1 }]);
      await c.query('reset role');
      const linked = await c.query<{ sub: string }>(
        `select cognito_sub as sub from core.app_user where username = 'acme.owner'`,
      );
      expect(linked.rows[0]!.sub).toBe('owner-sub');
    });
  });

  it('an empty queue is a no-op', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`update platform.job set status = 'done' where status = 'queued'`);
      expect(await asLoader(c, () => runNextJobNested(c))).toBeNull();
    });
  });
});

/** runNextJob, with the loader nested in the test transaction (savepoints, not BEGIN). */
function runNextJobNested(c: PoolClient) {
  return runNextJob(c, { nested: true });
}
