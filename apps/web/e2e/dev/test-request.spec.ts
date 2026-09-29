import { expect, test } from '@playwright/test';

// Dev-only pages (ADR 004), which production builds compile out: the dev login and the
// test request form. Runs against `next dev` with DEV_AUTH_STUB=true (project "dev").
// The production suite (e2e/*.spec.ts) covers everything else on the standalone server.
test('dev login and the test request form submit a request', async ({ page }) => {
  await page.goto('/dev-login');
  await page.getByRole('button', { name: /^Kim Storekeeper/ }).click();
  await expect(page.getByTestId('current-user')).toHaveText('Kim Storekeeper');

  await page.goto('/requests/new');
  await page.getByLabel('Request type').selectOption('PURCHASE_ORDER');
  await page.getByLabel('Location').last().selectOption({ label: 'Outlet A' });
  await page.getByLabel('Amount (INR)').fill('4200');
  await page.getByRole('button', { name: 'Submit request' }).click();

  await page.waitForURL(/\/requests\?created=/);
  const requestId = new URL(page.url()).searchParams.get('created')!;
  await expect(
    page.locator(`[data-request-id="${requestId}"]`).getByTestId('request-state'),
  ).toHaveText('in approval');
});
