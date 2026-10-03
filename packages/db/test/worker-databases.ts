// DB tests in parallel (CI speed): each Vitest worker gets its own copy of the seeded
// database, so test files that change data never meet. global-setup.ts makes the copies
// from the seeded database (CREATE DATABASE ... TEMPLATE) as the Postgres superuser
// (PG_ADMIN_URL, local and CI only); worker-setup.ts points each worker's connection
// strings at its copy. DB_TEST_WORKERS unset or 1: one worker on the seeded database, as
// before.

/** The connection strings a DB test (or what it starts) may use. */
export const DATABASE_URL_VARS = [
  'TEST_DATABASE_URL',
  'MIGRATOR_DATABASE_URL',
  'WF_EXECUTOR_DATABASE_URL',
  'PLATFORM_LOADER_DATABASE_URL',
  'DATABASE_URL',
] as const;

export function dbTestWorkers(): number {
  const n = Number(process.env.DB_TEST_WORKERS ?? 1);
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/** The seeded database's name, from TEST_DATABASE_URL. */
export function seededDatabase(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env.');
  return new URL(url).pathname.slice(1);
}

/** Worker n's copy (1-based, as VITEST_POOL_ID). */
export function workerDatabase(seeded: string, worker: number): string {
  return `${seeded}_w${worker}`;
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
