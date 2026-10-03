import { expect, test } from '@playwright/test';

// Dev-only page (ADR 004), compiled out of production builds: the dev login. Runs against
// `next dev` with DEV_AUTH_STUB=true (project "dev"). The temporary test request form is
// gone; real requests come from the inventory screens.
test('dev login signs in as a seeded user', async ({ page }) => {
  await page.goto('/dev-login');
  await page.getByRole('button', { name: /^Test Head Cook 3.0/ }).click();
  // next dev compiles the home page on its first request, which can take longer than the
  // default 5 s on a busy machine
  await expect(page.getByTestId('current-user')).toHaveText('Test Head Cook 3.0', {
    timeout: 30_000,
  });
  const res = await page.goto('/requests/new');
  expect(res?.status()).toBe(404);
});
