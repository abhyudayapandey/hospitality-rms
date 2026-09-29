import type { PoolClient } from 'pg';
import { PROCESS_DEFS } from './processes';
import type { ClaimedRequest } from './types';

/**
 * An execution handler runs inside the executor's transaction as wf_executor, with
 * app.wf_request set, after the request is approved (or rejected, for onRejected).
 * It must be idempotent on request.requestId: the executor guarantees at-most-once
 * commit per outbox row, but a handler can be retried after a failed attempt.
 */
export type Handler = (client: PoolClient, request: ClaimedRequest) => Promise<void>;
export type HandlerMap = Readonly<Record<string, Handler>>;

// Stubs until each module lands (rostering, leave, security).
const stub: Handler = async () => {};

export const STUB_HANDLERS: HandlerMap = Object.fromEntries(
  PROCESS_DEFS.flatMap((d) => [d.onApproved, ...(d.onRejected ? [d.onRejected] : [])]).map(
    (name) => [name, stub],
  ),
);

// Inventory handlers are SQL (inv.execute, SECURITY DEFINER, wf_executor only), so the
// business rules stay in the database next to the RPCs. Each is idempotent per request.
const inventory = (name: string): Handler => {
  return async (client, request) => {
    await client.query('select inv.execute($1, $2)', [name, request.requestId]);
  };
};

export const INVENTORY_HANDLERS: HandlerMap = Object.fromEntries(
  [
    'inv.stock_adjustment.post',
    'inv.stock_adjustment.reject',
    'inv.po.release',
    'inv.po.reject',
    'inv.transfer.post',
    'inv.transfer.reject',
  ].map((name) => [name, inventory(name)]),
);

/** What the executor runs: real handlers where a module exists, stubs elsewhere. */
export const HANDLERS: HandlerMap = { ...STUB_HANDLERS, ...INVENTORY_HANDLERS };
