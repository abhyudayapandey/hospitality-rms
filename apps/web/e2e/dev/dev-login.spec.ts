import { expect, test } from '@playwright/test';

// Dev-only page (ADR 004), compiled out of production builds: the dev login. Runs against
// `next dev` with DEV_AUTH_STUB=true (project "dev"). The temporary test request form is
// gone; real requests come from the inventory screens.
test('dev login signs in as a seeded user', async ({ page }) => {
  await page.goto('/dev-login');
  await page.getByRole('button', { name: /^Kim Storekeeper/ }).click();
  await expect(page.getByTestId('current-user')).toHaveText('Kim Storekeeper');
  const res = await page.goto('/requests/new');
  expect(res?.status()).toBe(404);
});
