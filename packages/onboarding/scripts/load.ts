import { join, resolve } from 'node:path';
import pg from 'pg';
import { loadCustomer } from '../src/apply';
import { readCustomerDir, readCustomerPhotos } from '../src/dir';
import { photoStore } from '../src/upload-store';

// Loads one customer's onboarding folder (ADR 009). A dry run unless --apply:
//   pnpm --filter @outlet-ops/onboarding load <folder> [--apply]
// Prints every problem as file:row column: message, the per-entity counts and, with
// --access, the resulting access in the file 99 layout. Runs as MIGRATOR_DATABASE_URL.
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'));
} catch {
  // no .env file; rely on the environment
}
const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) throw new Error('MIGRATOR_DATABASE_URL is not set');
const folder = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!folder) throw new Error('usage: load <folder> [--apply] [--access]');
const apply = process.argv.includes('--apply');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  // relative to where pnpm was run from, not the package
  const dir = resolve(process.env.INIT_CWD ?? process.cwd(), folder);
  const r = await loadCustomer(client, readCustomerDir(dir), {
    dryRun: !apply,
    photos: readCustomerPhotos(dir),
    putPhoto: photoStore(),
  });
  for (const i of r.issues) {
    console.error(
      `${i.file}${i.row ? `:${i.row}` : ''}${i.column ? ` ${i.column}` : ''}: ${i.message}`,
    );
  }
  for (const w of r.warnings) {
    console.warn(
      `WARNING ${w.file}${w.row ? `:${w.row}` : ''}${w.column ? ` ${w.column}` : ''}: ${w.message}`,
    );
  }
  for (const [entity, n] of Object.entries(r.counts)) {
    console.log(`${entity}: ${n.created} new, ${n.updated} changed, ${n.unchanged} unchanged`);
  }
  if (process.argv.includes('--access')) {
    for (const a of r.access) {
      console.log([a.username, a.access_group, a.node_code, a.covers, a.source].join(' | '));
    }
  }
  console.log(
    !r.ok
      ? `${r.customer ?? folder}: ${r.issues.length} problem(s), nothing written`
      : r.applied
        ? `${r.customer}: applied`
        : `${r.customer}: dry run OK, nothing written (add --apply to load)`,
  );
  process.exitCode = r.ok ? 0 : 1;
} finally {
  await client.end();
}
