import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

// An address that leads nowhere shows the app's words and a way Home (ADR 169).

test('an unknown address says so and leads Home', async ({ page }) => {
  await signInAs(page, 'Test Steward 1.0');
  const res = await page.goto('/no-such-screen');
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toContainText('We couldn’t find this');
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/$/);
});
