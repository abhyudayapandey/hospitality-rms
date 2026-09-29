import { join } from 'node:path';
import pg from 'pg';
import { syncProcessDefs } from '../src/sync';

// Upserts the code process definitions into wf.process_def. Part of `pnpm db:seed`.
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
} catch {
  // no .env file; rely on the environment
}
const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) throw new Error('MIGRATOR_DATABASE_URL is not set');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const n = await syncProcessDefs(client);
  console.log(`synced ${n} process definition(s)`);
} finally {
  await client.end();
}
