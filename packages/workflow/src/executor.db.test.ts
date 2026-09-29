import {
  appPool,
  closePools,
  loadSeedIds,
  migratorPool,
  type SeedIds,
} from '@outlet-ops/db/test-helpers';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from './executor';
import type { Handler } from './handlers';

// The executor commits, so these tests create real requests (via the RPCs, as the
// seeded users) and delete them afterwards as migrator. They use a stand-in process
// (TEST_EXEC, subject test.exec_subject, handler test.exec) so the engine is tested
// without the inventory module; everything is created in beforeAll and dropped after.

const executorPool = new pg.Pool({ connectionString: process.env.WF_EXECUTOR_DATABASE_URL });
const created: string[] = [];
let ids: SeedIds;

beforeAll(async () => {
  ids = await loadSeedIds();
  await migratorPool.query(`
    create table if not exists public.wf_test_exec_subject (
      id uuid primary key default core.uuid_v7(), tenant_id uuid not null,
      delivery_node_id uuid not null, amount numeric not null);
    create or replace function public.wf_test_exec_resolver(p_id uuid) returns wf.subject_info
    language sql stable as $$
      select tenant_id, null::uuid, delivery_node_id, null::uuid, null::uuid, amount, 'INR', true
        from public.wf_test_exec_subject where id = p_id $$;
    insert into core.subject_resolver (subject_type, resolver)
    values ('test.exec_subject', 'public.wf_test_exec_resolver(uuid)')
    on conflict (subject_type) do nothing;
    insert into wf.process_def (tenant_id, process_type, subject_type, domain_code,
                                hierarchy_type, steps, on_approved, sla_hours, definition)
    select tenant_id, 'TEST_EXEC', 'test.exec_subject', 'PURCHASE_ORDERS', 'delivery',
           '[{"step":"approve","group":"OUTLET_MANAGER","scope":"subject_node"}]',
           'test.exec', 24, '{}'
      from core.domain where code = 'PURCHASE_ORDERS'
    on conflict (tenant_id, process_type) do nothing;
    insert into core.bp_policy (tenant_id, process_type, step, group_id, action)
    select tenant_id, 'TEST_EXEC', s.step, id, s.action from core.security_group,
           (values ('*', 'initiate', 'STORE_KEEPER'), ('approve', 'approve', 'OUTLET_MANAGER'))
             s(step, action, grp)
     where code = s.grp
    on conflict do nothing;`);
});
afterEach(async () => {
  if (created.length === 0) return;
  await migratorPool.query('delete from wf.outbox where request_id = any($1)', [created]);
  await migratorPool.query('delete from wf.step_instance where request_id = any($1)', [created]);
  await migratorPool.query('delete from wf.request where id = any($1)', [created]);
  created.length = 0;
});
afterAll(async () => {
  await migratorPool.query(`
    delete from core.bp_policy where process_type = 'TEST_EXEC';
    delete from wf.process_def where process_type = 'TEST_EXEC';
    delete from core.subject_resolver where subject_type = 'test.exec_subject';
    drop function public.wf_test_exec_resolver(uuid);
    drop table public.wf_test_exec_subject;`);
  await executorPool.end();
  await closePools();
});

async function asUser<T>(name: string, text: string, params: unknown[]): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.user_id', $1, true)`, [ids.user(name)]);
    const { rows } = await c.query(text, params);
    await c.query('commit');
    return rows[0] as T;
  } catch (err) {
    await c.query('rollback');
    throw err;
  } finally {
    c.release();
  }
}

/** A TEST_EXEC request at Outlet A, approved by the outlet manager: one pending outbox row. */
async function approvedRequest(): Promise<string> {
  const subject = await migratorPool.query<{ id: string }>(
    `insert into public.wf_test_exec_subject (tenant_id, delivery_node_id, amount)
     select tenant_id, id, 1000 from core.hierarchy_node where id = $1 returning id`,
    [ids.node('delivery:Outlet A')],
  );
  const { id } = await asUser<{ id: string }>(
    'Kim Storekeeper',
    `select wf.submit('TEST_EXEC', 'test.exec_subject', $1) as id`,
    [subject.rows[0]!.id],
  );
  created.push(id);
  await asUser('Olivia Outlet Manager', `select wf.act($1, 'approve')`, [id]);
  return id;
}

async function state(id: string) {
  const { rows } = await migratorPool.query<{
    state: string;
    status: string;
    attempts: number;
    last_error: string | null;
  }>(
    `select r.state, o.status, o.attempts, o.last_error
       from wf.request r join wf.outbox o on o.request_id = r.id where r.id = $1`,
    [id],
  );
  return rows[0]!;
}

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe('executor', () => {
  it('runs the handler as wf_executor with app.wf_request set, then completes the request', async () => {
    const id = await approvedRequest();
    const seen: unknown[] = [];
    const handler: Handler = async (client, req) => {
      const { rows } = await client.query<{ role: string; wf: string; kind: string }>(
        `select current_user as role, current_setting('app.wf_request') as wf,
                current_setting('app.actor_kind') as kind`,
      );
      seen.push({ ...rows[0], requestId: req.requestId, processType: req.processType });
    };
    const r = await runOnce(executorPool, { 'test.exec': handler });
    expect(r).toEqual({ completed: 1, retrying: 0, failed: 0 });
    expect(seen).toEqual([
      {
        role: 'wf_executor',
        wf: id,
        kind: 'executor',
        requestId: id,
        processType: 'TEST_EXEC',
      },
    ]);
    expect(await state(id)).toMatchObject({ state: 'completed', status: 'done' });
  });

  it('is idempotent: a second run does not re-run the handler', async () => {
    const id = await approvedRequest();
    let calls = 0;
    const handlers = {
      'test.exec': (() => {
        calls++;
        return Promise.resolve();
      }) satisfies Handler,
    };
    await runOnce(executorPool, handlers);
    const again = await runOnce(executorPool, handlers, { now: later(60) });
    expect(again).toEqual({ completed: 0, retrying: 0, failed: 0 });
    expect(calls).toBe(1);
    expect((await state(id)).state).toBe('completed');
  });

  it('never runs a request twice when executors race', async () => {
    const id = await approvedRequest();
    let calls = 0;
    const handler: Handler = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 150)); // hold the row lock
    };
    const results = await Promise.all([
      runOnce(executorPool, { 'test.exec': handler }),
      runOnce(executorPool, { 'test.exec': handler }),
      runOnce(executorPool, { 'test.exec': handler }),
    ]);
    expect(calls).toBe(1);
    expect(results.reduce((n, r) => n + r.completed, 0)).toBe(1);
    expect((await state(id)).state).toBe('completed');
  });

  it('retries with backoff and marks the request failed after 3 attempts', async () => {
    const id = await approvedRequest();
    let calls = 0;
    const handlers = {
      'test.exec': (() => {
        calls++;
        return Promise.reject(new Error('supplier API down'));
      }) satisfies Handler,
    };

    expect(await runOnce(executorPool, handlers)).toEqual({ completed: 0, retrying: 1, failed: 0 });
    expect(await state(id)).toMatchObject({ state: 'approved', status: 'pending', attempts: 1 });

    // Backoff: not due again straight away.
    expect(await runOnce(executorPool, handlers)).toEqual({ completed: 0, retrying: 0, failed: 0 });

    expect(await runOnce(executorPool, handlers, { now: later(5) })).toEqual({
      completed: 0,
      retrying: 1,
      failed: 0,
    });
    expect(await runOnce(executorPool, handlers, { now: later(30) })).toEqual({
      completed: 0,
      retrying: 0,
      failed: 1,
    });
    expect(await state(id)).toEqual({
      state: 'failed',
      status: 'failed',
      attempts: 3,
      last_error: 'supplier API down',
    });
    expect(await runOnce(executorPool, handlers, { now: later(600) })).toEqual({
      completed: 0,
      retrying: 0,
      failed: 0,
    });
    expect(calls).toBe(3);
  });

  it('recovers from a SQL error inside the handler and keeps the row retryable', async () => {
    const id = await approvedRequest();
    const handlers = {
      'test.exec': (async (client) => {
        await client.query(`select 1/0`); // aborts the savepoint, not the executor transaction
      }) satisfies Handler,
    };
    await runOnce(executorPool, handlers);
    const s = await state(id);
    expect(s).toMatchObject({ state: 'approved', status: 'pending', attempts: 1 });
    expect(s.last_error).toMatch(/division by zero/);
  });

  it('records a missing handler as a failed attempt', async () => {
    const id = await approvedRequest();
    await runOnce(executorPool, {});
    expect((await state(id)).last_error).toBe('HANDLER_NOT_FOUND: test.exec');
  });
});
