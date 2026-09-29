import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

// Applies packages/db/seed/*.sql in filename order as the migrator role.
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
} catch {
  // no .env file; rely on the environment
}

const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) throw new Error('MIGRATOR_DATABASE_URL is not set');

const dir = join(import.meta.dirname, '..', 'seed');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of files) {
    console.log(`seed: ${file}`);
    await client.query(await readFile(join(dir, file), 'utf8'));
  }
  console.log(files.length ? `seeded ${files.length} file(s)` : 'no seed files');
} finally {
  await client.end();
}
