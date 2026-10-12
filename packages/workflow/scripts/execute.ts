import { join } from 'node:path';
import pg from 'pg';
import { runOnce } from '../src/executor';
import { HANDLERS } from '../src/handlers';
import { sendPushes } from '../src/push';

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
// Web Push (ADR 137): after each pass, the new notifications go to their owners' phones.
// Without a key (dev, CI, e2e) nothing is pushed.
const vapid = process.env.VAPID_PRIVATE_KEY?.trim();
// the push services' contact for us: VAPID_SUBJECT (mailto:), else the app's own address
const subject = process.env.VAPID_SUBJECT?.trim() || process.env.APP_URL?.trim() || '';
const log = (msg: string) => console.log(`[wf-execute] ${msg}`);

try {
  do {
    const r = await runOnce(pool, HANDLERS, { log });
    log(`completed=${r.completed} retrying=${r.retrying} failed=${r.failed}`);
    if (vapid && subject) {
      try {
        await sendPushes(pool, { privateHex: vapid, subject, log });
      } catch (err) {
        log(`push failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!once) await new Promise((resolve) => setTimeout(resolve, 60_000));
  } while (!once);
} finally {
  await pool.end();
}
