import { join } from 'node:path';
import pg from 'pg';

// Removes workflow requests created through the dev-only test form, so e2e runs leave
// no pending outbox rows behind for the DB and executor tests.
export default async function globalTeardown(): Promise<void> {
  try {
    process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
  } catch {
    // CI passes env vars directly
  }
  const client = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await client.connect();
  try {
    const ids = `select id from wf.request where payload ->> 'test' = 'true'`;
    await client.query(`delete from wf.outbox where request_id in (${ids})`);
    await client.query(`delete from wf.step_instance where request_id in (${ids})`);
    await client.query(`delete from wf.request where id in (${ids})`);
  } finally {
    await client.end();
  }
}
