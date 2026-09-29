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

// Stubs until each module lands (inventory, orders, rostering, leave, security).
const stub: Handler = async () => {};

export const STUB_HANDLERS: HandlerMap = Object.fromEntries(
  PROCESS_DEFS.flatMap((d) => [d.onApproved, ...(d.onRejected ? [d.onRejected] : [])]).map(
    (name) => [name, stub],
  ),
);
