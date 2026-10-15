import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Three projects, one server each. Needs the seeded database.
//   prod: e2e/*.spec.ts against the standalone server (node .next/standalone/.../server.js),
//         the artifact the release bundle ships. Needs `next build` first (`pnpm e2e` does
//         it). Dev login is compiled out there, so tests sign in with a signed session
//         cookie (e2e/helpers.ts).
//   dev:  e2e/dev/*.spec.ts, the dev-only pages, against `next dev` with DEV_AUTH_STUB.
//   signin: e2e/signin/*.spec.ts, the sign-in screen typed into for real (ADR 161), against a
//         second standalone server whose Cognito is e2e/signin/fake-cognito.mjs on this
//         machine. Its own server, so the other tests never reach a Cognito.
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '.env'));
} catch {
  // CI passes env vars directly
}
const prodPort = Number(process.env.E2E_PORT ?? 3100);
const devPort = Number(process.env.E2E_DEV_PORT ?? 3101);
const signinPort = Number(process.env.E2E_SIGNIN_PORT ?? 3102);
const fakeCognitoPort = Number(process.env.FAKE_COGNITO_PORT ?? 3109);
const photoDir = process.env.PHOTO_DIR || join(tmpdir(), 'outlet-ops-e2e-photos');
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
      testIgnore: ['dev/**', 'signin/**'],
      use: { baseURL: `http://127.0.0.1:${prodPort}` },
    },
    {
      name: 'dev',
      testMatch: 'dev/**/*.spec.ts',
      use: { baseURL: `http://localhost:${devPort}` },
    },
    {
      name: 'signin',
      testMatch: 'signin/**/*.spec.ts',
      use: { baseURL: `http://127.0.0.1:${signinPort}` },
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
        // no bucket here: every step's photo is kept on this machine (ADR 127)
        PHOTO_DIR: photoDir,
        // alerts on this phone (ADR 137): a public key only; nothing is ever pushed here
        VAPID_PUBLIC_KEY:
          'BCe4Hze287AIh12i0en1a1cSp0kAM98U9FE8hOl4xb-RK7NYq40cgRYsPCaRa9V9HMsCMgs1LmXny_Rh_69-n20',
      },
    },
    {
      command: `pnpm exec next dev --port ${devPort}`,
      url: `http://localhost:${devPort}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { DEV_AUTH_STUB: 'true', APP_URL: `http://localhost:${devPort}`, PHOTO_DIR: photoDir },
    },
    {
      command: 'node e2e/signin/fake-cognito.mjs',
      url: `http://127.0.0.1:${fakeCognitoPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 10_000,
      env: { FAKE_COGNITO_PORT: String(fakeCognitoPort) },
    },
    {
      // after the prod server, which copies the static files both use
      command: 'bash scripts/start-standalone.sh',
      url: `http://127.0.0.1:${signinPort}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: String(signinPort),
        BIND_HOST: '127.0.0.1',
        STANDALONE_ASSETS_READY: '1',
        APP_URL: `http://127.0.0.1:${signinPort}`,
        COGNITO_USER_POOL_ID: 'ap-south-1_E2eSignIn',
        COGNITO_CLIENT_ID: 'e2e-web-client',
        COGNITO_DOMAIN: 'fake-cognito.invalid',
        COGNITO_IDP_ENDPOINT: `http://127.0.0.1:${fakeCognitoPort}`,
        PHOTO_DIR: photoDir,
      },
    },
  ],
});
