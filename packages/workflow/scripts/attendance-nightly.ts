import { join } from 'node:path';
import pg from 'pg';

// Nightly attendance job (ADR 008): late / no_show / missing_clock_out / unscheduled
// exceptions for recent local days, and the 90-day purge of raw clock-in coordinates.
// Runs as wf_executor (systemd timer on the instance; locally on demand):
//   pnpm --filter @outlet-ops/workflow attendance-nightly
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
  const { rows } = await client.query<{ exceptions: number; purged: number }>(
    'select * from hr.nightly_attendance()',
  );
  await client.query('commit');
  console.log(
    `[attendance-nightly] exceptions=${rows[0]?.exceptions ?? 0} purged=${rows[0]?.purged ?? 0}`,
  );
} catch (err) {
  await client.query('rollback').catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
