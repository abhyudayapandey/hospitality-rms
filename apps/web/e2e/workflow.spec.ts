import { expect, test } from '@playwright/test';
import { signInAs, submitTestRequest } from './helpers';

// The acceptance flow on the production build: the store keeper's request is in approval,
// is not in her own inbox, and the outlet manager approves it. The dev-only submit form
// is covered by e2e/dev/test-request.spec.ts against `next dev`.
test('store keeper submits a request; outlet manager approves it', async ({ page }) => {
  const requestId = await submitTestRequest('Kim Storekeeper', 'PURCHASE_ORDER', 12500);

  await signInAs(page, 'Kim Storekeeper');
  await page.goto('/requests');
  const mine = page.locator(`[data-request-id="${requestId}"]`);
  await expect(mine.getByTestId('request-state')).toHaveText('in approval');

  // Kim cannot approve her own request: it is not in her inbox.
  await page.goto('/inbox');
  await expect(page.locator(`[data-request-id="${requestId}"]`)).toHaveCount(0);

  await signInAs(page, 'Olivia Outlet Manager');
  await page.goto('/inbox');
  const item = page.locator(`[data-testid="inbox-item"][data-request-id="${requestId}"]`);
  await expect(item).toContainText('Purchase Order');
  await expect(item).toContainText('12,500');
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(item.getByRole('status')).toHaveText('Approved');
  await expect(item).toHaveCount(0); // leaves the inbox after the refresh

  await signInAs(page, 'Kim Storekeeper');
  await page.goto('/requests');
  await expect(
    page.locator(`[data-request-id="${requestId}"]`).getByTestId('request-state'),
  ).toHaveText('approved');
});

test('a stale screen gets a friendly message, not a SQL error', async ({ page, context }) => {
  const requestId = await submitTestRequest('Kim Storekeeper', 'PURCHASE_ORDER', 900);

  await signInAs(page, 'Olivia Outlet Manager');
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
