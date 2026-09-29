import { expect, test } from '@playwright/test';
import { devLogin } from './helpers';

// The acceptance flow: the store keeper submits a request, the outlet manager approves it.
test('store keeper submits a test request; outlet manager approves it', async ({ page }) => {
  await devLogin(page, 'Kim Storekeeper');

  await page.goto('/requests/new');
  await page.getByLabel('Request type').selectOption('PURCHASE_ORDER');
  await page.getByLabel('Location').last().selectOption({ label: 'Outlet A' });
  await page.getByLabel('Amount (INR)').fill('12500');
  await page.getByRole('button', { name: 'Submit request' }).click();

  await page.waitForURL(/\/requests\?created=/);
  const requestId = new URL(page.url()).searchParams.get('created')!;
  const mine = page.locator(`[data-request-id="${requestId}"]`);
  await expect(mine.getByTestId('request-state')).toHaveText('in approval');

  // Kim cannot approve her own request: it is not in her inbox.
  await page.goto('/inbox');
  await expect(page.locator(`[data-request-id="${requestId}"]`)).toHaveCount(0);

  await devLogin(page, 'Olivia Outlet Manager');
  await page.goto('/inbox');
  const item = page.locator(`[data-testid="inbox-item"][data-request-id="${requestId}"]`);
  await expect(item).toContainText('Purchase Order');
  await expect(item).toContainText('12,500');
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(item.getByRole('status')).toHaveText('Approved');
  await expect(item).toHaveCount(0); // leaves the inbox after the refresh

  await devLogin(page, 'Kim Storekeeper');
  await page.goto('/requests');
  await expect(
    page.locator(`[data-request-id="${requestId}"]`).getByTestId('request-state'),
  ).toHaveText('approved');
});

test('a stale screen gets a friendly message, not a SQL error', async ({ page, context }) => {
  await devLogin(page, 'Kim Storekeeper');
  await page.goto('/requests/new');
  await page.getByLabel('Request type').selectOption('PURCHASE_ORDER');
  await page.getByLabel('Amount (INR)').fill('900');
  await page.getByRole('button', { name: 'Submit request' }).click();
  await page.waitForURL(/\/requests\?created=/);
  const requestId = new URL(page.url()).searchParams.get('created')!;

  await devLogin(page, 'Olivia Outlet Manager');
  const stale = await context.newPage();
  await stale.goto('/inbox');
  const staleItem = stale.locator(`[data-testid="inbox-item"][data-request-id="${requestId}"]`);
  await expect(staleItem).toBeVisible();

  await page.goto('/inbox');
  const item = page.locator(`[data-testid="inbox-item"][data-request-id="${requestId}"]`);
  await item.getByRole('button', { name: 'Reject' }).click();
  await expect(item.getByRole('status')).toHaveText('Rejected');

  await staleItem.getByRole('button', { name: 'Approve' }).click();
  await expect(staleItem.getByRole('alert')).toHaveText(
    'This request has already been actioned. Refresh to see the latest.',
  );
});
