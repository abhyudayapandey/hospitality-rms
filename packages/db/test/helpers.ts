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

export type NodeKey = `${'org' | 'delivery'}:${string}`;

export interface SeedIds {
  user(name: string): string;
  node(key: NodeKey): string;
}

/** Resolves seeded users and nodes by name so tests never hard-code UUIDs. */
export async function loadSeedIds(): Promise<SeedIds> {
  const users = await migratorPool.query<{ id: string; display_name: string }>(
    'select id, display_name from core.app_user',
  );
  const nodes = await migratorPool.query<{ id: string; type: string; name: string }>(
    'select id, type, name from core.hierarchy_node',
  );
  const userMap = new Map(users.rows.map((r) => [r.display_name, r.id]));
  const nodeMap = new Map(nodes.rows.map((r) => [`${r.type}:${r.name}`, r.id]));
  return {
    user(name) {
      const id = userMap.get(name);
      if (!id) throw new Error(`seed user not found: ${name} (run pnpm db:seed)`);
      return id;
    },
    node(key) {
      const id = nodeMap.get(key);
      if (!id) throw new Error(`seed node not found: ${key} (run pnpm db:seed)`);
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
