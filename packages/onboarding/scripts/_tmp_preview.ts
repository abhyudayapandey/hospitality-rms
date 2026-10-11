import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadCustomer } from '../src/apply';
import { readCustomerDir } from '../src/dir';
const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');
const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const pool = new pg.Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL });
for (const c of process.argv.slice(2)) {
  const dir = c.includes('/') ? c : join(DATA, c);
  const files = readCustomerDir(dir);
  const client = await pool.connect();
  await client.query('begin');
  const r = await loadCustomer(client, files, { nested: true, dryRun: true });
  await client.query('rollback');
  client.release();
  if (r.issues.length) { console.log(c, r.issues.slice(0, 5)); continue; }
  const cols = ['username', 'display_name', 'access_group', 'node_code', 'place_name', 'covers', 'source'] as const;
  const out = [cols.join(','), ...r.access.map((a) => cols.map((k) => cell(String(a[k]))).join(','))].join('\n') + '\n';
  writeFileSync(join(dir, '99_access_preview_GENERATED.csv'), out);
  console.log(c, r.access.length);
}
await pool.end();
