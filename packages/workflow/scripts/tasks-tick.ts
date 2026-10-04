import { join } from 'node:path';
import pg from 'pg';

// The tasks job (ADR 020), every 5 minutes: checklist instances for the next 24 hours,
// reminders 30 minutes before the due time, and escalation when a task is overdue; and,
// once each business day from 04:00, the expiry alert to the leads of each store's team
// (INV-12, ADR 040).
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
  await client.query('begin');
  await client.query(`select set_config('app.actor_kind', 'executor', true)`);
  const { rows } = await client.query<{ created: number; reminded: number; escalated: number }>(
    'select * from ops.tasks_tick()',
  );
  const alerts = await client.query<{ sent: number }>('select ops.expiry_alerts() as sent');
  await client.query('commit');
  const r = rows[0];
  console.log(
    `[tasks-tick] created=${r?.created ?? 0} reminded=${r?.reminded ?? 0} escalated=${r?.escalated ?? 0} expiry_alerts=${alerts.rows[0]?.sent ?? 0}`,
  );
} catch (err) {
  await client.query('rollback').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
