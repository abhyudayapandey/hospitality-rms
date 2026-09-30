import { join } from 'node:path';
import pg from 'pg';
import { syncProcessDefs, syncProductAccess } from '../src/sync';

// Writes the product-wide access definition (groups, domains, policy matrix, bp_policy)
// and the process definitions into every tenant, in one transaction. Part of
// `pnpm db:seed` and of every deploy.
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
  await client.query('begin');
  await syncProductAccess(client);
  const n = await syncProcessDefs(client);
  await client.query('commit');
  console.log(`synced product access and ${n} process definition(s)`);
} catch (err) {
  await client.query('rollback');
  throw err;
} finally {
  await client.end();
}
