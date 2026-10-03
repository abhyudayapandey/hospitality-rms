import {
  DATABASE_URL_VARS,
  dbTestWorkers,
  seededDatabase,
  withDatabase,
  workerDatabase,
} from './worker-databases';

// Runs in each DB test worker before a test file is loaded: with DB_TEST_WORKERS > 1,
// every connection string (and so every pool and process the test starts) points at this
// worker's copy of the seeded database (global-setup.ts).
const workers = dbTestWorkers();
if (workers > 1) {
  const worker = Number(process.env.VITEST_POOL_ID);
  if (!Number.isInteger(worker) || worker < 1 || worker > workers) {
    throw new Error(`DB test worker ${process.env.VITEST_POOL_ID} has no database copy`);
  }
  const database = workerDatabase(seededDatabase(), worker);
  for (const name of DATABASE_URL_VARS) {
    const url = process.env[name];
    if (url) process.env[name] = withDatabase(url, database);
  }
}
