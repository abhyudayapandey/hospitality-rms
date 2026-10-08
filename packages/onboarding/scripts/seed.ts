import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { loadCustomer } from '../src/apply';
import { readCustomerDir, readCustomerPhotos } from '../src/dir';
import { photoStore } from '../src/upload-store';

// `pnpm db:seed`: loads the two test customers (docs/onboarding/test-data) with the
// onboarding loader, exactly as the Platform Admin console will, then applies
// packages/db/seed/dev/*.sql (activity the files do not carry: shifts, punches, pay).
// Development and CI only; production customers are loaded from their own files.
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
} catch {
  // no .env file; rely on the environment
}
const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) throw new Error('MIGRATOR_DATABASE_URL is not set');

const repo = join(import.meta.dirname, '..', '..', '..');
const data = join(repo, 'docs', 'onboarding', 'test-data');
const dev = join(repo, 'packages', 'db', 'seed', 'dev');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const customer of ['test-company', 'test-solo-bar-co']) {
    const dir = join(data, customer);
    const r = await loadCustomer(client, readCustomerDir(dir), {
      photos: readCustomerPhotos(dir),
      putPhoto: photoStore(),
    });
    if (!r.applied) {
      for (const i of r.issues) {
        console.error(
          `${i.file}${i.row ? `:${i.row}` : ''}${i.column ? ` ${i.column}` : ''}: ${i.message}`,
        );
      }
      throw new Error(`seed: ${customer} did not load`);
    }
    const changed = Object.entries(r.counts)
      .filter(([, n]) => n.created || n.updated)
      .map(([k, n]) => `${k} +${n.created} ~${n.updated}`);
    console.log(`seed: ${customer} ${changed.length ? changed.join(', ') : 'unchanged'}`);
  }
  const files = (await readdir(dev)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    console.log(`seed: dev/${f}`);
    await client.query(await readFile(join(dev, f), 'utf8'));
  }
} finally {
  await client.end();
}
