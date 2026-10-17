import { join } from 'node:path';
import pg from 'pg';
import { runJobs, TASKS_TICK_JOBS } from '../src/ticks';

// The tasks job (ADR 020), every 5 minutes: approvals past their time or with nobody left to
// approve move up their chain (ADR 167); checklist instances for the next 24 hours, reminders
// 30 minutes before the due time, and escalation when a task is overdue; and, once each
// business day from 04:00, the expiry alert to the leads of each store's team (INV-12,
// ADR 040); and licence and compliance calendar reminders where Compliance is on (ADR 069).
// Each job runs for each customer in its own transaction, so one customer's trouble stops
// only their part (ADR 167); anything that failed makes the run exit non-zero.
// Runs as wf_executor (systemd timer on the instance; locally on demand):
//   pnpm --filter @outlet-ops/workflow tasks-tick
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
} catch {
  // no .env file; rely on the environment
}
const url = process.env.WF_EXECUTOR_DATABASE_URL;
if (!url) throw new Error('WF_EXECUTOR_DATABASE_URL is not set');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const r = await runJobs(client, TASKS_TICK_JOBS, {
    log: (m) => console.error(`[tasks-tick] ${m}`),
  });
  const sum = (job: string, field: string) =>
    Object.entries(r.done)
      .filter(([k]) => k.startsWith(`${job} `))
      .reduce((n, [, row]) => n + Number(row?.[field] ?? 0), 0);
  console.log(
    `[tasks-tick] created=${sum('tasks', 'created')} reminded=${sum('tasks', 'reminded')} escalated=${sum('tasks', 'escalated')} expiry_alerts=${sum('expiry', 'sent')} compliance=${sum('compliance', 'created')}/${sum('compliance', 'noticed')} approvals=${sum('approvals', 'escalated')}/${sum('approvals', 'rerouted')} stuck_approvals=${sum('approvals', 'unroutable')} failed=${r.failed.length}`,
  );
  if (r.failed.length > 0) process.exitCode = 1;
} finally {
  await client.end();
}
