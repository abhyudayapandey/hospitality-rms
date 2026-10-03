import pg from 'pg';
import { dbTestWorkers, seededDatabase, workerDatabase } from './worker-databases';

// Fails fast with a clear message when the DB tests cannot reach Postgres,
// or when the database has not been migrated and seeded.
// With DB_TEST_WORKERS > 1, also makes one copy of the seeded database per worker
// (worker-databases.ts) and drops them when the run ends.
export default async function setup(): Promise<(() => Promise<void>) | void> {
  for (const name of [
    'TEST_DATABASE_URL',
    'MIGRATOR_DATABASE_URL',
    'WF_EXECUTOR_DATABASE_URL',
  ] as const) {
    const url = process.env[name];
    if (!url) {
      throw new Error(`${name} is not set. Copy .env.example to .env.`);
    }
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('select 1');
    } catch (err) {
      throw new Error(
        `Cannot reach Postgres at ${name}. Run "pnpm db:up && pnpm db:migrate && pnpm db:seed".`,
        { cause: err },
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  const workers = dbTestWorkers();
  if (workers === 1) return;
  const adminUrl = process.env.PG_ADMIN_URL;
  if (!adminUrl) {
    throw new Error(
      `DB_TEST_WORKERS=${workers} needs PG_ADMIN_URL (the local Postgres superuser, see ` +
        '.env.example) to copy the seeded database. Unset DB_TEST_WORKERS to run serially.',
    );
  }
  const seeded = seededDatabase();
  const copies = Array.from({ length: workers }, (_, i) => workerDatabase(seeded, i + 1));
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const drop = async () => {
    for (const db of copies) await admin.query(`drop database if exists "${db}" with (force)`);
  };
  try {
    await drop();
    for (const db of copies) {
      // a copy needs the seeded database idle: no app server or other session on it
      await admin.query(`create database "${db}" template "${seeded}" strategy file_copy`);
    }
  } catch (err) {
    await admin.end().catch(() => undefined);
    throw new Error(
      `Could not copy ${seeded} for the DB test workers. Stop anything connected to it ` +
        '(pnpm dev, an open psql) and run again.',
      { cause: err },
    );
  }
  return async () => {
    try {
      await drop();
    } finally {
      await admin.end().catch(() => undefined);
    }
  };
}
