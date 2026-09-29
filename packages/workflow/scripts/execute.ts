import { join } from 'node:path';
import pg from 'pg';
import { runOnce } from '../src/executor';
import { HANDLERS } from '../src/handlers';

// Local runner for the workflow executor (the wf-execute Lambda wraps runOnce later).
//   pnpm --filter @outlet-ops/workflow execute          poll every 60 s
//   pnpm --filter @outlet-ops/workflow execute --once   drain once and exit
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
} catch {
  // no .env file; rely on the environment
}
const url = process.env.WF_EXECUTOR_DATABASE_URL;
if (!url) throw new Error('WF_EXECUTOR_DATABASE_URL is not set');

const pool = new pg.Pool({ connectionString: url });
const once = process.argv.includes('--once');
const log = (msg: string) => console.log(`[wf-execute] ${msg}`);

try {
  do {
    const r = await runOnce(pool, HANDLERS, { log });
    log(`completed=${r.completed} retrying=${r.retrying} failed=${r.failed}`);
    if (!once) await new Promise((resolve) => setTimeout(resolve, 60_000));
  } while (!once);
} finally {
  await pool.end();
}
