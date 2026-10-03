import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import TimedSequencer from './packages/db/test/sequencer';

// Two projects:
//   unit - *.test.ts, no external services
//   db   - *.db.test.ts, real Postgres at TEST_DATABASE_URL (never mocked); one file at a
//          time, or DB_TEST_WORKERS files at once, each worker on its own copy of the
//          seeded database (packages/db/test/worker-databases.ts)
// Load .env locally if present; CI passes env vars directly.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file
}

const dbWorkers = Math.max(1, Math.trunc(Number(process.env.DB_TEST_WORKERS ?? 1)) || 1);

const exclude = ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/cdk.out/**'];

export default defineConfig({
  test: {
    // shards by expected time, slowest files first (ADR 029)
    sequence: { sequencer: TimedSequencer },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages,services,infra}/**/*.test.ts'],
          exclude: [...exclude, '**/*.db.test.ts'],
          environment: 'node',
        },
        // apps/web's `@/` import alias (its tsconfig paths), for tests of its routes
        resolve: {
          alias: [
            { find: /^@\//, replacement: fileURLToPath(new URL('./apps/web/', import.meta.url)) },
          ],
        },
      },
      {
        test: {
          name: 'db',
          include: ['{apps,packages,services}/**/*.db.test.ts'],
          exclude,
          environment: 'node',
          globalSetup: ['./packages/db/test/global-setup.ts'],
          setupFiles: ['./packages/db/test/worker-setup.ts'],
          fileParallelism: dbWorkers > 1,
          maxWorkers: dbWorkers,
          // a hang guard: the longest tests (loading a whole customer) take 10 to 13 s on
          // their own, and longer straight after the heaviest files or beside other workers
          testTimeout: dbWorkers > 1 ? 120_000 : 30_000,
        },
      },
    ],
  },
});
