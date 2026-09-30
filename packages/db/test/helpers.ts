import pg from 'pg';

// Test helpers for DB integration tests. Two connections:
//  - app:      TEST_DATABASE_URL as app_rw, exactly like the running app
//  - migrator: MIGRATOR_DATABASE_URL, used to build fixture tables inside a
//              transaction that is always rolled back, then SET LOCAL ROLE to
//              app_rw / wf_executor to exercise the generated policies.

export const appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
export const migratorPool = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });

export async function closePools(): Promise<void> {
  await Promise.all([appPool.end(), migratorPool.end()]);
}

/** A place code from the test data, e.g. `TEST-BAR-3.0-KITCHEN-STORE`. */
export type NodeKey = string;

export interface SeedIds {
  /** A username from the test data (Test Company; `test.solo.*` are Test Solo Bar Co.). */
  user(username: string): string;
  node(code: NodeKey): string;
  /** Which tree a place is in. */
  type(code: NodeKey): 'org' | 'delivery';
  /** The tenant id of a test customer (default Test Company). */
  tenant(customer?: 'TEST-COMPANY' | 'TEST-SOLO-COMPANY'): string;
}

/**
 * Resolves the test customers' users and places (docs/onboarding/test-data, loaded by
 * `pnpm db:seed`) by username and code, so tests never hard-code UUIDs.
 */
export async function loadSeedIds(): Promise<SeedIds> {
  const tenants = await migratorPool.query<{ id: string; code: string }>(
    `select id, code from core.tenant where code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY')`,
  );
  const tenantMap = new Map(tenants.rows.map((r) => [r.code, r.id]));
  const users = await migratorPool.query<{ id: string; username: string; code: string }>(
    `select u.id, u.username, t.code from core.app_user u join core.tenant t on t.id = u.tenant_id
      where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and u.username is not null`,
  );
  const nodes = await migratorPool.query<{ id: string; code: string; type: 'org' | 'delivery' }>(
    `select n.id, n.code, n.type from core.hierarchy_node n join core.tenant t on t.id = n.tenant_id
      where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and n.code is not null`,
  );
  const typeMap = new Map(nodes.rows.map((r) => [r.code, r.type]));
  // usernames repeat across customers only for the AI agent: prefer Test Company's
  const userMap = new Map<string, string>();
  for (const r of users.rows) {
    if (r.code === 'TEST-COMPANY' || !userMap.has(r.username)) userMap.set(r.username, r.id);
  }
  const nodeMap = new Map(nodes.rows.map((r) => [r.code, r.id]));
  return {
    user(username) {
      const id = userMap.get(username);
      if (!id) throw new Error(`test user not found: ${username} (run pnpm db:seed)`);
      return id;
    },
    node(code) {
      const id = nodeMap.get(code);
      if (!id) throw new Error(`test place not found: ${code} (run pnpm db:seed)`);
      return id;
    },
    type(code) {
      const t = typeMap.get(code);
      if (!t) throw new Error(`test place not found: ${code} (run pnpm db:seed)`);
      return t;
    },
    tenant(customer = 'TEST-COMPANY') {
      const id = tenantMap.get(customer);
      if (!id) throw new Error(`test customer not found: ${customer} (run pnpm db:seed)`);
      return id;
    },
  };
}

/**
 * Runs `fn` on a migrator connection inside a transaction that is always
 * rolled back, so fixture tables and data never persist.
 */
export async function inRolledBackTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await migratorPool.connect();
  try {
    await client.query('begin');
    return await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** Switches the current transaction to `role` acting as `userId` (null = no user). */
export async function actAs(
  c: pg.PoolClient,
  role: 'app_rw' | 'wf_executor',
  userId: string | null,
): Promise<void> {
  await c.query(`set local role ${role}`);
  await c.query(`select set_config('app.user_id', $1, true)`, [userId ?? '']);
}

/** Back to the migrator role inside the same transaction. */
export async function resetRole(c: pg.PoolClient): Promise<void> {
  await c.query('reset role');
  await c.query(`select set_config('app.user_id', '', true)`);
}

export type Attempt<T> = { rows: T[]; error?: undefined } | { rows?: undefined; error: string };

/**
 * Runs `text` as app_rw acting as `userId` inside a savepoint. Returns the rows, or the
 * error message (our stable codes, e.g. NOT_AUTHORISED) without aborting the transaction.
 */
export async function attemptAs<T extends object = Record<string, unknown>>(
  c: pg.PoolClient,
  userId: string,
  text: string,
  params: unknown[] = [],
): Promise<Attempt<T>> {
  await actAs(c, 'app_rw', userId);
  await c.query('savepoint attempt');
  try {
    const r = await c.query<T>(text, params);
    await c.query('release savepoint attempt');
    return { rows: r.rows };
  } catch (err) {
    await c.query('rollback to savepoint attempt');
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    await resetRole(c);
  }
}

export interface FixtureSubject {
  org?: string | null;
  delivery?: string | null;
  from?: string | null;
  to?: string | null;
  amount?: number | null;
  submittable?: boolean;
  /** defaults to the tenant of the first node given */
  tenant?: string;
}

/**
 * Stand-in subjects for workflow-engine tests (inside a rolled-back transaction):
 * creates public.wf_test_subject and a resolver, and points the given subject types at
 * it, so engine tests do not depend on module tables or their business rules. Call as
 * migrator (outside attemptAs). Returns a function that inserts one subject row.
 */
export async function installSubjectFixture(
  c: pg.PoolClient,
  subjectTypes: string[],
): Promise<(s: FixtureSubject) => Promise<string>> {
  await c.query(`
    create table public.wf_test_subject (
      id uuid primary key default core.uuid_v7(),
      tenant_id uuid not null, org_node_id uuid, delivery_node_id uuid,
      from_node_id uuid, to_node_id uuid, amount numeric, submittable boolean not null)`);
  await c.query(`
    create function public.wf_test_resolver(p_id uuid) returns wf.subject_info
    language sql stable as $$
      select tenant_id, org_node_id, delivery_node_id, from_node_id, to_node_id, amount,
             'INR', submittable
        from public.wf_test_subject where id = p_id $$`);
  await c.query(
    `insert into core.subject_resolver (subject_type, resolver)
     select t, 'public.wf_test_resolver(uuid)'::regprocedure from unnest($1::text[]) t
     on conflict (subject_type) do update set resolver = excluded.resolver`,
    [subjectTypes],
  );
  return async (s) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into public.wf_test_subject (tenant_id, org_node_id, delivery_node_id,
                                           from_node_id, to_node_id, amount, submittable)
       values (coalesce($1::uuid, (select tenant_id from core.hierarchy_node
                                    where id = coalesce($2::uuid, $3::uuid, $4::uuid, $5::uuid))),
               $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric, $7::boolean)
       returning id`,
      [
        s.tenant ?? null,
        s.org ?? null,
        s.delivery ?? null,
        s.from ?? null,
        s.to ?? null,
        s.amount ?? null,
        s.submittable ?? true,
      ],
    );
    return rows[0]!.id;
  };
}

/** Runs `sql` inside a savepoint and returns the SQLSTATE it failed with, or null. */
export async function sqlState(
  c: pg.PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<string | null> {
  await c.query('savepoint probe');
  try {
    await c.query(text, params);
    await c.query('release savepoint probe');
    return null;
  } catch (err) {
    await c.query('rollback to savepoint probe');
    return (err as { code?: string }).code ?? 'unknown';
  }
}
