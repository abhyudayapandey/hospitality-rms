import { BUSINESS_RULE_CODES } from '@outlet-ops/domain';
import type { Pool } from 'pg';
import type { HandlerMap } from './handlers';
import type { ClaimedRequest } from './types';

// Outbox executor (LLD section 4; CLAUDE.md: wf.outbox polled by wf-execute). Connect
// `pool` as wf_executor. Each row is handled in one transaction:
//   claim (FOR UPDATE SKIP LOCKED) -> savepoint -> handler -> complete -> commit
// On handler error: rollback to savepoint, record the failure, commit. The third
// failure marks the row and the request failed (wf.record_failure); a business-rule
// code fails it on the first attempt.

export interface RunResult {
  completed: number;
  retrying: number;
  failed: number;
}

interface ClaimRow {
  outbox_id: string;
  request_id: string;
  handler: string;
  attempts: number;
  process_type: string;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  amount: string | null;
  currency: string | null;
  org_node_id: string | null;
  delivery_node_id: string | null;
  initiator_id: string;
  tenant_id: string;
}

export interface RunOptions {
  /** Upper bound on rows handled in this run. */
  maxRows?: number;
  /** Clock for due-time checks; tests pass a future time to skip backoff. */
  now?: Date;
  log?: (msg: string) => void;
}

export async function runOnce(
  pool: Pool,
  handlers: HandlerMap,
  opts: RunOptions = {},
): Promise<RunResult> {
  const result: RunResult = { completed: 0, retrying: 0, failed: 0 };
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});

  for (let i = 0; i < (opts.maxRows ?? 100); i++) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.actor_kind', 'executor', true)`);
      const { rows } = await client.query<ClaimRow>('select * from wf.claim_next($1)', [now]);
      const row = rows[0];
      if (!row) {
        await client.query('commit');
        break;
      }
      const request = toRequest(row);
      const handler = handlers[row.handler];

      await client.query('savepoint handler');
      try {
        if (!handler) throw new Error(`HANDLER_NOT_FOUND: ${row.handler}`);
        await handler(client, request);
        await client.query('release savepoint handler');
        await client.query('select wf.complete_outbox($1)', [row.outbox_id]);
        result.completed++;
        log(`completed ${row.handler} for ${row.request_id}`);
      } catch (err) {
        await client.query('rollback to savepoint handler');
        const message = err instanceof Error ? err.message : String(err);
        // A business rule (REST_RULE, INSUFFICIENT_STOCK, ...) fails the same way on every
        // retry: fail the request now and record the code (ADR 008).
        const final = BUSINESS_RULE_CODES.has(message);
        const { rows: f } = await client.query<{ status: string }>(
          'select wf.record_failure($1, $2, $3, $4) as status',
          [row.outbox_id, message, now, final],
        );
        if (f[0]?.status === 'failed') result.failed++;
        else result.retrying++;
        log(`attempt failed for ${row.handler} on ${row.request_id}: ${String(err)}`);
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return result;
}

function toRequest(r: ClaimRow): ClaimedRequest {
  return {
    outboxId: r.outbox_id,
    requestId: r.request_id,
    handler: r.handler,
    attempts: r.attempts,
    processType: r.process_type,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    payload: r.payload,
    amount: r.amount,
    currency: r.currency,
    orgNodeId: r.org_node_id,
    deliveryNodeId: r.delivery_node_id,
    initiatorId: r.initiator_id,
    tenantId: r.tenant_id,
  };
}
