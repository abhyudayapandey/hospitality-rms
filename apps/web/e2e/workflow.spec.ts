import { expect, test } from '@playwright/test';
import { createOrder, PLACE, placeId, runExecutor, signInAs } from './helpers';

// The acceptance flow on the production build, through the real screens: the store keeper
// (Test Bar 3.0's head cook) orders, cannot approve their own order, the outlet manager
// (the Bar Manager) approves it, the executor releases it, the store keeper places the order and receives it and
// stock on hand goes up. Paper napkins are in no recipe, so the order is off the menu and
// needs the department head or the GM (PO-5, ADR 044); the head cook is the department head
// and made it, so it goes to the Bar Manager, the GM.
test('store keeper orders, outlet manager approves, store keeper receives', async ({ page }) => {
  const store = await placeId(PLACE.store);
  await signInAs(page, 'Test Head Cook 3.0');
  const napkins = page.locator('[data-sku="PAPER-NAPKINS-PACK-OF-100"] [data-testid="on-hand"]');
  await page.goto(`/stock?node=${store}`);
  const before = parseFloat((await napkins.textContent())!.replace(/,/g, ''));

  const po = await createOrder(page, 'Test Paper Napkins (Pack of 100)', '5');
  await expect(page.getByTestId('po-progress')).toHaveText('awaiting approval');

  // The head cook cannot approve their own order: it is not in their inbox.
  await page.goto('/inbox');
  await expect(page.locator(`a[href^="/stock/orders/${po}"]`)).toHaveCount(0);

  await signInAs(page, 'Test Bar Manager 3.0');
  await page.goto('/inbox');
  const item = page.getByTestId('inbox-item').filter({
    has: page.locator(`a[href^="/stock/orders/${po}"]`),
  });
  await expect(item).toContainText('Purchase Order');
  await expect(item).toContainText('Test Head Cook 3.0');
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(item.getByRole('status')).toHaveText('Approved');

  await runExecutor(); // releases the PO (inv.po.release)

  await signInAs(page, 'Test Head Cook 3.0');
  await page.goto(`/stock/orders/${po}?node=${store}`);
  // approved, now the store's keeper places the order (ADR 049): a date, no supplier needed
  await expect(page.getByTestId('po-progress')).toHaveText('to be ordered');
  await page.getByRole('button', { name: 'Ordered' }).click();
  await expect(page.getByTestId('po-progress')).toHaveText('ordered');
  // nothing filled in (ADR 051): what arrived and what it cost, the amount required
  const napkinsIn = page.getByRole('textbox', {
    name: 'Received Test Paper Napkins (Pack of 100)',
  });
  await expect(napkinsIn).toHaveValue('');
  await page.getByRole('button', { name: 'Everything arrived as ordered' }).click();
  await expect(napkinsIn).toHaveValue('5');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.getByTestId('receive-form').getByRole('alert')).toContainText(
    'Enter the amount for Test Paper Napkins',
  );
  await page.getByRole('textbox', { name: 'Amount Test Paper Napkins (Pack of 100)' }).fill('250');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.getByTestId('po-progress')).toHaveText('received');
  await expect(page.getByTestId('po-paid')).toContainText('₹250.00');

  await page.goto(`/stock?node=${store}`);
  expect(parseFloat((await napkins.textContent())!.replace(/,/g, ''))).toBe(before + 5);
});

test('a stale screen gets a friendly message, not a SQL error', async ({ page, context }) => {
  await signInAs(page, 'Test Head Cook 3.0');
  const po = await createOrder(page, 'Test Aluminium Foil Roll', '2');

  await signInAs(page, 'Test Bar Manager 3.0');
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
