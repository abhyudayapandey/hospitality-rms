import { defineConfig, devices } from '@playwright/test';

// End-to-end tests against `next dev` (dev login is compiled out of production builds;
// the production check is scripts/check-prod-dev-auth.sh). Needs the seeded database.
const port = Number(process.env.E2E_PORT ?? 3100);
const executablePath = process.env.PW_CHROMIUM_PATH; // local override for a preinstalled browser

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    ...devices['Pixel 7'], // mobile-first (412 px wide)
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: `pnpm exec next dev --port ${port}`,
    url: `http://localhost:${port}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { DEV_AUTH_STUB: 'true' },
  },
});
