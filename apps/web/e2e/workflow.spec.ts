import { expect, test } from '@playwright/test';
import { createOrder, NODE, runExecutor, signInAs } from './helpers';

// The acceptance flow on the production build, through the real screens: the store keeper
// orders, cannot approve her own order, the outlet manager approves it, the executor
// releases it, the store keeper receives it and stock on hand goes up.
test('store keeper orders, outlet manager approves, store keeper receives', async ({ page }) => {
  await signInAs(page, 'Kim Storekeeper');
  const onions = page.locator('[data-sku="VEG-ONION"] [data-testid="on-hand"]');
  await page.goto(`/stock?node=${NODE.outletA}`);
  const before = parseFloat((await onions.textContent())!.replace(/,/g, ''));

  const po = await createOrder(page, 'Onions', '5');
  await expect(page.getByTestId('po-progress')).toHaveText('awaiting approval');

  // Kim cannot approve her own order: it is not in her inbox.
  await page.goto('/inbox');
  await expect(page.locator(`a[href^="/stock/orders/${po}"]`)).toHaveCount(0);

  await signInAs(page, 'Olivia Outlet Manager');
  await page.goto('/inbox');
  const item = page.getByTestId('inbox-item').filter({
    has: page.locator(`a[href^="/stock/orders/${po}"]`),
  });
  await expect(item).toContainText('Purchase Order');
  await expect(item).toContainText('Kim Storekeeper');
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(item.getByRole('status')).toHaveText('Approved');

  await runExecutor(); // releases the PO (inv.po.release)

  await signInAs(page, 'Kim Storekeeper');
  await page.goto(`/stock/orders/${po}?node=${NODE.outletA}`);
  await expect(page.getByTestId('po-progress')).toHaveText('ordered');
  await expect(page.getByRole('textbox', { name: 'Received Onions' })).toHaveValue('5');
  await page.getByRole('button', { name: 'Receive goods' }).click();
  await expect(page.getByRole('status')).toHaveText('Received.');
  await expect(page.getByTestId('po-progress')).toHaveText('received');

  await page.goto(`/stock?node=${NODE.outletA}`);
  await expect(onions).toHaveText(`${before + 5} kg`);
});

test('a stale screen gets a friendly message, not a SQL error', async ({ page, context }) => {
  await signInAs(page, 'Kim Storekeeper');
  const po = await createOrder(page, 'Tomatoes', '2');

  await signInAs(page, 'Olivia Outlet Manager');
  const stale = await context.newPage();
  await stale.goto('/inbox');
  const staleItem = stale.getByTestId('inbox-item').filter({
    has: stale.locator(`a[href^="/stock/orders/${po}"]`),
  });
  await expect(staleItem).toBeVisible();

  await page.goto('/inbox');
  const item = page.getByTestId('inbox-item').filter({
    has: page.locator(`a[href^="/stock/orders/${po}"]`),
  });
  await item.getByRole('button', { name: 'Reject' }).click();
  await expect(item.getByRole('status')).toHaveText('Rejected');

  await staleItem.getByRole('button', { name: 'Approve' }).click();
  await expect(staleItem.getByRole('alert')).toHaveText(
    'This request has already been actioned. Refresh to see the latest.',
  );
});
