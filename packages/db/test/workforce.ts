import type pg from 'pg';
import type { NodeKey, SeedIds } from './helpers';

// Workforce fixtures for DB tests, used inside inRolledBackTx as migrator. Idempotent:
// the test customers' people already have workers (loaded from file 07), which these
// fixtures reuse; new workers get one of these job roles.

export const JOB_ROLES = ['MANAGER', 'SERVER', 'COOK', 'STORE', 'CLEANER'] as const;
export type JobRole = (typeof JOB_ROLES)[number];

/** Test Company's tenant. */
export function tenantOf(_c: pg.PoolClient, ids: SeedIds): Promise<string> {
  return Promise.resolve(ids.tenant());
}

export async function ensureJobRoles(c: pg.PoolClient, tenant: string): Promise<void> {
  await c.query(
    `insert into hr.job_role (tenant_id, code, name)
     select $1, code, initcap(code) from unnest($2::text[]) code
     on conflict (tenant_id, code) do nothing`,
    [tenant, JOB_ROLES],
  );
}

/** The worker for a seeded user (created at `node` with `role` if missing). */
export async function workerFor(
  c: pg.PoolClient,
  ids: SeedIds,
  userName: string,
  node: NodeKey,
  role: JobRole,
): Promise<string> {
  const tenant = await tenantOf(c, ids);
  await ensureJobRoles(c, tenant);
  const user = ids.user(userName);
  await c.query(
    `insert into hr.worker (tenant_id, owner_user_id, org_node_id, role_code, joined_on)
     values ($1, $2, $3, $4, date '2026-01-01')
     on conflict (tenant_id, owner_user_id) do nothing`,
    [tenant, user, ids.node(node), role],
  );
  const { rows } = await c.query<{ id: string }>(
    'select id from hr.worker where owner_user_id = $1',
    [user],
  );
  return rows[0]!.id;
}

/** A fresh person with no worker record (every test-data user has one). */
export async function newUser(c: pg.PoolClient, ids: SeedIds, name: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into core.app_user (tenant_id, kind, display_name) values ($1, 'human', $2)
     returning id`,
    [ids.tenant(), name],
  );
  return rows[0]!.id;
}

export interface NewWorker {
  userId: string;
  workerId: string;
}

/** A fresh user + worker (STAFF at `node`, plus any extra groups). */
export async function newWorker(
  c: pg.PoolClient,
  ids: SeedIds,
  name: string,
  node: NodeKey,
  role: JobRole,
  groups: [string, NodeKey][] = [],
): Promise<NewWorker> {
  const tenant = await tenantOf(c, ids);
  await ensureJobRoles(c, tenant);
  const userId = (
    await c.query<{ id: string }>(
      `insert into core.app_user (tenant_id, kind, display_name) values ($1, 'human', $2)
       returning id`,
      [tenant, name],
    )
  ).rows[0]!.id;
  for (const [grp, n] of [['STAFF', node] as [string, NodeKey], ...groups]) {
    await c.query(
      `insert into core.role_assignment (tenant_id, user_id, group_id, node_id, effective_from)
       select $1, $2, id, $4, date '2026-01-01' from core.security_group
        where tenant_id = $1 and code = $3`,
      [tenant, userId, grp, ids.node(n)],
    );
  }
  const workerId = (
    await c.query<{ id: string }>(
      `insert into hr.worker (tenant_id, owner_user_id, org_node_id, role_code, joined_on)
       values ($1, $2, $3, $4, date '2026-01-01') returning id`,
      [tenant, userId, ids.node(node), role],
    )
  ).rows[0]!.id;
  return { userId, workerId };
}

/**
 * Empties workforce activity (shifts, templates, punches, exceptions, leave requests,
 * swaps, events, notifications) inside the test's rolled-back transaction, so tests do
 * not depend on the dev seed or on e2e residue. Workers, roles, leave types, balances and
 * geofences stay.
 */
export async function clearWorkforce(c: pg.PoolClient): Promise<void> {
  await c.query(`
    delete from hr.attendance_exception;
    delete from hr.attendance;
    delete from hr.shift_swap;
    delete from hr.shift_assignment;
    delete from hr.shift;
    delete from hr.shift_template;
    delete from hr.leave_request;
    delete from ops.event_requirement;
    delete from ops.event;
    delete from ops.notification;`);
}
