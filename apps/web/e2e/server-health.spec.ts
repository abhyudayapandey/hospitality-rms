import { expect, test } from '@playwright/test';
import { asMigrator, signInPlatform } from './helpers';

// Someone is told when the back office stops (ADR 171): /health is what the outside check
// calls, /health/db what the deploy checks, and the platform console says which job is late.

const fresh = () =>
  asMigrator(`update platform.job_heartbeat set last_ok_at = now(), last_failed_at = null`, []);

test.afterAll(fresh);

test('health: fine when every job ran in time; 503 when one is late; the deploy check only asks the database', async ({
  request,
}) => {
  await fresh();
  const ok = await request.get('/health');
  expect(ok.status()).toBe(200);
  expect(await ok.text()).toBe('ok');

  await asMigrator(
    `update platform.job_heartbeat set last_ok_at = now() - interval '8 hours' where job = 'pg-backup'`,
    [],
  );
  const late = await request.get('/health');
  expect(late.status()).toBe(503);
  // nothing but yes or no: which job is late is for the console
  expect(await late.text()).toBe('not ok');
  expect((await request.get('/health/db')).status()).toBe(200);
});

test('the console says which server job is late, in words', async ({ page }) => {
  await fresh();
  await signInPlatform(page);
  await page.goto('/platform');
  await expect(page.getByTestId('server-ok')).toHaveText('Every job ran on time.');

  await asMigrator(
    `update platform.job_heartbeat set last_failed_at = now(), last_error = 'disk full'
      where job = 'pg-backup'`,
    [],
  );
  await page.reload();
  const row = page.getByTestId('server-late').locator('[data-job="pg-backup"]');
  await expect(row).toContainText('Backups');
  await expect(row).toContainText('disk full');
});
