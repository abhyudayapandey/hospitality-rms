import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Two projects, one server each. Needs the seeded database.
//   prod: e2e/*.spec.ts against the standalone server (node .next/standalone/.../server.js),
//         the artifact the release bundle ships. Needs `next build` first (`pnpm e2e` does
//         it). Dev login is compiled out there, so tests sign in with a signed session
//         cookie (e2e/helpers.ts).
//   dev:  e2e/dev/*.spec.ts, the dev-only pages, against `next dev` with DEV_AUTH_STUB.
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '.env'));
} catch {
  // CI passes env vars directly
}
const prodPort = Number(process.env.E2E_PORT ?? 3100);
const devPort = Number(process.env.E2E_DEV_PORT ?? 3101);
const executablePath = process.env.PW_CHROMIUM_PATH; // local override for a preinstalled browser
// clock-in takes the selfie from the live camera (ADR 076): a fake one, allowed without asking
const cameraArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 60_000,
  use: {
    trace: 'retain-on-failure',
    ...devices['Pixel 7'], // mobile-first (412 px wide)
    launchOptions: { args: cameraArgs, ...(executablePath ? { executablePath } : {}) },
    permissions: ['camera'],
  },
  projects: [
    {
      name: 'prod',
      testIgnore: 'dev/**',
      use: { baseURL: `http://127.0.0.1:${prodPort}` },
    },
    {
      name: 'dev',
      testMatch: 'dev/**/*.spec.ts',
      use: { baseURL: `http://localhost:${devPort}` },
    },
  ],
  webServer: [
    {
      command: 'bash scripts/start-standalone.sh',
      url: `http://127.0.0.1:${prodPort}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // APP_URL is the origin the tests use: admin actions refuse any other (ADR 011)
      env: {
        PORT: String(prodPort),
        BIND_HOST: '127.0.0.1',
        APP_URL: `http://127.0.0.1:${prodPort}`,
      },
    },
    {
      command: `pnpm exec next dev --port ${devPort}`,
      url: `http://localhost:${devPort}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { DEV_AUTH_STUB: 'true', APP_URL: `http://localhost:${devPort}` },
    },
  ],
});
