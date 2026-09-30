import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

// Applies packages/db/seed/*.sql, then packages/db/seed/dev/*.sql (development data:
// items, workers, shifts, events), each in filename order, as the migrator role.
// Production never runs this: its data comes from the pilot onboarding script.
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
} catch {
  // no .env file; rely on the environment
}

const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) throw new Error('MIGRATOR_DATABASE_URL is not set');

const root = join(import.meta.dirname, '..', 'seed');
const sqlFiles = async (dir: string) =>
  (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(dir, f));
const files = [...(await sqlFiles(root)), ...(await sqlFiles(join(root, 'dev')))];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of files) {
    console.log(`seed: ${file.slice(root.length + 1)}`);
    await client.query(await readFile(file, 'utf8'));
  }
  console.log(files.length ? `seeded ${files.length} file(s)` : 'no seed files');
} finally {
  await client.end();
}
