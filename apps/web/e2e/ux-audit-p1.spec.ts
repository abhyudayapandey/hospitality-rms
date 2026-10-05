import { expect, test, type Page } from '@playwright/test';
import { placeId, runExecutor, signInAs } from './helpers';

// UX audit 3's serious findings (ADR 052) through the real screens, at phone width: the
// keeper's To order on Home, the department following its order "on the way" with no ₹ and no
// receive form, "Rest is not coming", withdrawing a request, the Stock screen's list before its
// jobs, and the dark theme by default. The rules are in order-close.db.test.ts.

/** The chef asks the Main Store for onions; approved if it asked. Returns the order. */
async function askForOnions(page: Page): Promise<string> {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock/orders/new?node=${kitchen}`);
  for (const input of await page.getByRole('textbox', { name: /^Quantity / }).all()) {
    await input.fill('');
  }
  await page.getByRole('textbox', { name: 'Quantity Test Onions' }).fill('2');
  await page.getByRole('button', { name: /^Send request/ }).click();
  await page.waitForURL(/\/stock\/orders\/[0-9a-f-]{36}/);
  const po = new URL(page.url()).pathname.split('/').pop()!;
  await runExecutor();
  await page.reload();
  if ((await page.getByTestId('po-progress').textContent()) === 'awaiting approval') {
    await signInAs(page, 'Test General Manager 1.0');
    await page.goto('/inbox');
    const item = page.getByTestId('inbox-item').filter({
      has: page.locator(`a[href^="/stock/orders/${po}"]`),
    });
    await item.getByRole('button', { name: 'Approve' }).click();
    await expect(item.getByRole('status')).toHaveText('Approved');
    await runExecutor();
  }
  return po;
}

test('the keeper sees To order on Home; the chef follows the order, on the way, with no ₹', async ({
  page,
}) => {
  const po = await askForOnions(page);

  await signInAs(page, 'Test Store Keeper 1.0');
  // requests to order come first on Home, and the To do list badge counts them
  const tile = page.getByTestId('tile-to-order');
  await expect(tile).toContainText('To order');
  await tile.click();
  await page.waitForURL(/tab=to_order/);
  await page.locator(`[data-po-id="${po}"]`).getByRole('link').click();
  await page.waitForURL(`**/stock/orders/${po}**`);
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Ordered' }).click();
  await expect(page.getByTestId('po-progress')).toHaveText('ordered');

  // the department follows it: on the way, no receive form, no ₹
  await signInAs(page, 'Test Executive Chef 1.0');
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await page.goto(`/stock/orders?node=${kitchen}&tab=receive`);
  await expect(page.getByTestId('tab-receive')).toContainText('On the way');
  const row = page.locator(`[data-po-id="${po}"]`);
  await expect(row.getByTestId('po-progress')).toHaveText('on the way');
  await expect(row).not.toContainText('₹');
  await row.getByRole('link').click();
  await page.waitForURL(`**/stock/orders/${po}**`);
  await expect(page.getByTestId('po-progress')).toHaveText('on the way');
  await expect(page.getByTestId('receive-form')).toHaveCount(0);
  await expect(page.getByTestId('close-order')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('₹');

  // Things I asked for: a supply request with its items and where it is
  await page.goto('/requests');
  const mine = page.getByTestId('request-item').filter({ has: page.locator(`a[href*="${po}"]`) });
  await expect(mine).toContainText('Supply request');
  await expect(mine).toContainText('Test Onions');
  await expect(mine.getByTestId('request-state')).toHaveText('on the way');
  await expect(mine).not.toContainText('₹');

  // the keeper gets part of it; the rest is not coming
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/orders/${po}`);
  await page.getByRole('textbox', { name: 'Received Test Onions' }).fill('1');
  await page.getByRole('textbox', { name: 'Amount Test Onions' }).fill('40');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.getByTestId('po-progress')).toHaveText('part received');
  const close = page.getByTestId('close-order');
  await close.getByText('Rest is not coming').click();
  await close.getByRole('button', { name: 'Close the order' }).click();
  await expect(close.getByRole('alert')).toContainText('Say why');
  await close.getByRole('textbox', { name: 'Why' }).fill('Supplier out of onions');
  await close.getByRole('button', { name: 'Close the order' }).click();
  await expect(page.getByTestId('po-closed')).toContainText('Supplier out of onions');
  await expect(page.getByTestId('po-progress')).toHaveText('closed');
  await expect(page.getByTestId('receive-form')).toHaveCount(0);

  // the GM is told
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/notifications');
  await expect(page.locator('main')).toContainText('closed');
});

test('whoever asked withdraws a request nobody has ordered yet', async ({ page }) => {
  const po = await askForOnions(page);
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock/orders/${po}`);
  const withdraw = page.getByTestId('withdraw');
  await withdraw.getByRole('button', { name: 'Withdraw this request' }).click();
  await withdraw.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await expect(page.getByTestId('po-progress')).toHaveText('withdrawn');
  await expect(page.getByTestId('withdraw')).toHaveCount(0);

  // it left the keeper's To order
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto('/inbox');
  await expect(page.locator(`a[href^="/stock/orders/${po}"]`)).toHaveCount(0);
});

test('Stock: the list first; the Main Store sends, asking is a small link', async ({ page }) => {
  const main = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock?node=${main}`);
  const jobs = page.getByRole('navigation', { name: 'Stock jobs' });
  await expect(jobs.getByRole('link').first()).toHaveText('Send stock');
  await expect(jobs.getByRole('link', { name: 'Ask for supplies' })).toHaveCount(0);
  await expect(
    page.getByTestId('stock-more').getByRole('link', { name: 'Ask for supplies' }),
  ).toBeVisible();
  const lastRow = page.getByTestId('stock-row').last();
  expect((await jobs.boundingBox())!.y).toBeGreaterThan((await lastRow.boundingBox())!.y);
});

test('Running low says what to do: ask for these, store by store', async ({ page }) => {
  await signInAs(page, 'Test Executive Chef 1.0');
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await page.goto(`/stock?node=${kitchen}&tab=low`);
  const rows = page.getByTestId('stock-row');
  test.skip((await rows.count()) === 0, 'nothing is low in the kitchen today');
  const ask = page.getByTestId('order-low').getByRole('link').first();
  await expect(ask).toHaveText('Ask for these');
  await ask.click();
  await page.waitForURL(/\/stock\/orders\/new\?node=/);
});

test('dark by default; the toggle by Notifications switches to light and stays', async ({
  page,
}) => {
  await signInAs(page, 'Test Executive Chef 1.0');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toHaveAccessibleName('Light view');
  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('theme-toggle')).toHaveAccessibleName('Dark view');
  await page.getByTestId('theme-toggle').click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});
