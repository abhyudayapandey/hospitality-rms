import { join } from 'node:path';
import pg from 'pg';

// Nightly attendance job (ADR 008): late / no_show / missing_clock_out / unscheduled
// exceptions for recent local days, and the 90-day purge of raw clock-in coordinates;
// then the report tables (ADR 023).
// Runs as wf_executor (systemd timer on the instance; locally on demand):
//   pnpm --filter @outlet-ops/workflow attendance-nightly
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
} catch {
  // no .env file; rely on the environment
}
const url = process.env.WF_EXECUTOR_DATABASE_URL;
if (!url) throw new Error('WF_EXECUTOR_DATABASE_URL is not set');

// --reports-only rebuilds the report tables and nothing else (pnpm db:seed uses it).
const reportsOnly = process.argv.includes('--reports-only');

const client = new pg.Client({ connectionString: url });
await client.connect();

/** One job in its own transaction, as the executor. */
async function job<T extends object>(sql: string): Promise<T | undefined> {
  try {
    await client.query('begin');
    await client.query(`select set_config('app.actor_kind', 'executor', true)`);
    const { rows } = await client.query<T>(sql);
    await client.query('commit');
    return rows[0];
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}

try {
  if (!reportsOnly) {
    const r = await job<{ exceptions: number; purged: number }>(
      'select * from hr.nightly_attendance()',
    );
    console.log(`[attendance-nightly] exceptions=${r?.exceptions ?? 0} purged=${r?.purged ?? 0}`);
  }
  // the report tables (ADR 023): the last 35 business days, after the day's exceptions
  const rep = await job<{ n: number }>('select rpt.nightly() as n');
  console.log(`[attendance-nightly] report rows changed=${rep?.n ?? 0}`);
} finally {
  await client.end();
}
