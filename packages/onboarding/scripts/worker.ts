import pg from 'pg';
import { runNextJob } from '../src/worker';

// outlet-ops-platform-worker (ADR 012): runs queued platform jobs (creating customers) as
// platform_loader. The only credential it gets is PLATFORM_LOADER_DATABASE_URL; the web
// app never holds it. `--once` drains the queue and exits.
//   pnpm --filter @outlet-ops/onboarding worker [--once]

const url = process.env.PLATFORM_LOADER_DATABASE_URL;
if (!url) throw new Error('PLATFORM_LOADER_DATABASE_URL is not set');
const once = process.argv.includes('--once');
const IDLE_MS = 2000;

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => (stopping = true));

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  while (!stopping) {
    let ran: string | null = null;
    try {
      ran = await runNextJob(client);
      if (ran) console.log(`job ${ran} finished`);
    } catch (err) {
      // the job stays 'running' only if finishing it failed; it is reported, not retried
      console.error('platform job failed to run', (err as Error).message);
    }
    if (!ran) {
      if (once) break;
      await new Promise((r) => setTimeout(r, IDLE_MS));
    }
  }
} finally {
  await client.end();
}
