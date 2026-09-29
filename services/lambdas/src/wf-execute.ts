import type { ScheduledHandler } from 'aws-lambda';

// Polls wf.outbox every minute and runs approved workflow handlers as wf_executor.
// Thin wrapper over @outlet-ops/workflow; not implemented yet.
export const handler: ScheduledHandler = async () => {};
