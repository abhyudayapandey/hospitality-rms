import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Two projects:
//   unit - *.test.ts, no external services
//   db   - *.db.test.ts, real Postgres at TEST_DATABASE_URL (never mocked), run serially
// Load .env locally if present; CI passes env vars directly.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file
}

const exclude = ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/cdk.out/**'];

export default defineConfig({
  test: {
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
          fileParallelism: false,
          testTimeout: 15_000,
        },
      },
    ],
  },
});
