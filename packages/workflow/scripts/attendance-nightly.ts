import { join } from 'node:path';
import pg from 'pg';
import { NIGHTLY_JOBS, REPORT_JOBS, runJobs } from '../src/ticks';

// Nightly attendance job (ADR 008): late / no_show / missing_clock_out / unscheduled
// exceptions for recent local days, the 90-day purge of raw clock-in coordinates, and the
// removal of selfies and devices older than the personnel retention rule (ADR 045) and of
// task photos older than 30 days (ADR 079); the audit log's monthly partitions (ADR 167);
// then the report tables (ADR 023). Each step runs in its own transaction and a failed one
// does not stop the rest (ADR 167); anything that failed makes the run exit non-zero.
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
try {
  const r = await runJobs(client, reportsOnly ? REPORT_JOBS : [...NIGHTLY_JOBS, ...REPORT_JOBS], {
    log: (m) => console.error(`[attendance-nightly] ${m}`),
  });
  const d = r.done;
  const n = (job: string, field = 'n') => Number(d[job]?.[field] ?? 0);
  if (!reportsOnly) {
    console.log(
      `[attendance-nightly] exceptions=${n('attendance', 'exceptions')} purged=${n('attendance', 'purged')}`,
    );
    console.log(`[attendance-nightly] selfies and devices removed=${n('personnel')}`);
    console.log(`[attendance-nightly] task photos removed=${n('task photos')}`);
    console.log(`[attendance-nightly] audit partitions made=${n('audit partitions')}`);
  }
  console.log(`[attendance-nightly] report rows changed=${n('reports')}`);
  if (r.failed.length > 0) process.exitCode = 1;
} finally {
  await client.end();
}
