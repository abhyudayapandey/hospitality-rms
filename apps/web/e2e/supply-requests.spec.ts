import { expect, test } from '@playwright/test';
import { placeId, runExecutor, signInAs } from './helpers';

// Supply requests (ADR 049): the chef asks for items and quantities only; the Main Store's
// keeper places the order from their To do list, then receives it. The rules are in
// supply-requests.db.test.ts.

test('the chef asks for supplies with no supplier or price; the Main Store keeper orders and receives', async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock/orders/new?node=${kitchen}`);
  // no supplier and no price anywhere on the form
  await expect(page.getByRole('combobox', { name: 'Supplier' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /^Price / })).toHaveCount(0);
  for (const input of await page.getByRole('textbox', { name: /^Quantity / }).all()) {
    await input.fill('');
  }
  await page.getByRole('textbox', { name: 'Quantity Test Mint Chutney' }).fill('1');
  await page.getByRole('button', { name: /^Send request/ }).click();
  await page.waitForURL(/\/stock\/orders\/[0-9a-f-]{36}/);
  const po = new URL(page.url()).pathname.split('/').pop()!;

  // off the menu or more than usual waits for the department head or GM
  if ((await page.getByTestId('po-progress').textContent()) === 'awaiting approval') {
    await signInAs(page, 'Test General Manager 1.0');
    await page.goto('/inbox');
    const item = page.getByTestId('inbox-item').filter({
      has: page.locator(`a[href^="/stock/orders/${po}"]`),
    });
    await item.getByRole('button', { name: 'Approve' }).click();
    await expect(item.getByRole('status')).toHaveText('Approved');
  }
  await runExecutor();

  // the Main Store's keeper has it on the To do list, and orders it
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto('/inbox');
  const task = page
    .getByTestId('desk-to_order')
    .getByTestId('desk-order')
    .filter({
      has: page.locator(`a[href^="/stock/orders/${po}"]`),
    });
  await expect(task).toBeVisible();
  await task.getByRole('link').click();
  await page.waitForURL(`**/stock/orders/${po}**`);
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Ordered' }).click();
  await expect(page.getByTestId('po-progress')).toHaveText('ordered');

  // the task closed itself and the receive task took its place
  await page.goto('/inbox');
  await expect(
    page.getByTestId('desk-to_order').locator(`a[href^="/stock/orders/${po}"]`),
  ).toHaveCount(0);
  const receive = page.getByTestId('desk-to_receive').locator(`a[href^="/stock/orders/${po}"]`);
  await receive.click();
  await page.getByRole('button', { name: 'Receive goods' }).click();
  await expect(page.getByTestId('po-progress')).toHaveText('received');
  await page.goto('/inbox');
  await expect(page.locator(`a[href^="/stock/orders/${po}"]`)).toHaveCount(0);
});
