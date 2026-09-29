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
// seeded users) and delete them afterwards as migrator.

const executorPool = new pg.Pool({ connectionString: process.env.WF_EXECUTOR_DATABASE_URL });
const created: string[] = [];
let ids: SeedIds;

beforeAll(async () => {
  ids = await loadSeedIds();
});
afterEach(async () => {
  if (created.length === 0) return;
  await migratorPool.query('delete from wf.outbox where request_id = any($1)', [created]);
  await migratorPool.query('delete from wf.step_instance where request_id = any($1)', [created]);
  await migratorPool.query('delete from wf.request where id = any($1)', [created]);
  created.length = 0;
});
afterAll(async () => {
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

/** A PO at Outlet A, approved by the outlet manager: one pending outbox row. */
async function approvedPurchaseOrder(): Promise<string> {
  const { id } = await asUser<{ id: string }>(
    'Kim Storekeeper',
    `select wf.submit('PURCHASE_ORDER', 'inv.purchase_order', core.uuid_v7(), '{}', 1000, 'INR',
                      null, $1) as id`,
    [ids.node('delivery:Outlet A')],
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
    const id = await approvedPurchaseOrder();
    const seen: unknown[] = [];
    const handler: Handler = async (client, req) => {
      const { rows } = await client.query<{ role: string; wf: string; kind: string }>(
        `select current_user as role, current_setting('app.wf_request') as wf,
                current_setting('app.actor_kind') as kind`,
      );
      seen.push({ ...rows[0], requestId: req.requestId, processType: req.processType });
    };
    const r = await runOnce(executorPool, { 'inv.po.release': handler });
    expect(r).toEqual({ completed: 1, retrying: 0, failed: 0 });
    expect(seen).toEqual([
      {
        role: 'wf_executor',
        wf: id,
        kind: 'executor',
        requestId: id,
        processType: 'PURCHASE_ORDER',
      },
    ]);
    expect(await state(id)).toMatchObject({ state: 'completed', status: 'done' });
  });

  it('is idempotent: a second run does not re-run the handler', async () => {
    const id = await approvedPurchaseOrder();
    let calls = 0;
    const handlers = {
      'inv.po.release': (() => {
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
    const id = await approvedPurchaseOrder();
    let calls = 0;
    const handler: Handler = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 150)); // hold the row lock
    };
    const results = await Promise.all([
      runOnce(executorPool, { 'inv.po.release': handler }),
      runOnce(executorPool, { 'inv.po.release': handler }),
      runOnce(executorPool, { 'inv.po.release': handler }),
    ]);
    expect(calls).toBe(1);
    expect(results.reduce((n, r) => n + r.completed, 0)).toBe(1);
    expect((await state(id)).state).toBe('completed');
  });

  it('retries with backoff and marks the request failed after 3 attempts', async () => {
    const id = await approvedPurchaseOrder();
    let calls = 0;
    const handlers = {
      'inv.po.release': (() => {
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
    const id = await approvedPurchaseOrder();
    const handlers = {
      'inv.po.release': (async (client) => {
        await client.query(`select 1/0`); // aborts the savepoint, not the executor transaction
      }) satisfies Handler,
    };
    await runOnce(executorPool, handlers);
    const s = await state(id);
    expect(s).toMatchObject({ state: 'approved', status: 'pending', attempts: 1 });
    expect(s.last_error).toMatch(/division by zero/);
  });

  it('records a missing handler as a failed attempt', async () => {
    const id = await approvedPurchaseOrder();
    await runOnce(executorPool, {});
    expect((await state(id)).last_error).toBe('HANDLER_NOT_FOUND: inv.po.release');
  });
});
