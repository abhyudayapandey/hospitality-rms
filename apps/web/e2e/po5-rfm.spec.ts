import { expect, test } from '@playwright/test';
import { PLACE, placeId, signInAs } from './helpers';

// Department heads are responsible for orders and requests for material (PO-5, TR-3; ADR 044),
// through the real screens. The rules and the approvers are in po5-rfm.db.test.ts.

test('an order says before sending whether the department head must approve', async ({ page }) => {
  const store = await placeId(PLACE.store);
  await signInAs(page, 'Test Head Cook 3.0');
  await page.goto(`/stock/orders/new?node=${store}`);
  for (const input of await page.getByRole('textbox', { name: /^Quantity / }).all()) {
    await input.fill('');
  }
  // paper napkins are in no recipe of the outlet
  await page.getByRole('textbox', { name: 'Quantity Test Paper Napkins (Pack of 100)' }).fill('3');
  await expect(page.getByTestId('unusual-needs')).toContainText(
    'Test Paper Napkins (Pack of 100): not on the menu',
  );
  // a pinch of a menu ingredient is usual: no approval
  await page.getByRole('textbox', { name: 'Quantity Test Paper Napkins (Pack of 100)' }).fill('');
  await page.getByRole('textbox', { name: 'Quantity Test Onions' }).fill('0.01');
  await expect(page.getByTestId('unusual-none')).toBeVisible();
  await expect(page.getByTestId('unusual-needs')).toHaveCount(0);
});

test('a request for material off the menu waits for the department head, with why, then the store keeper', async ({
  page,
}) => {
  const store = await placeId(PLACE.store);
  const ck = await placeId(PLACE.centralKitchen);
  await signInAs(page, 'Test Cook 3.0');
  await page.goto(`/stock/transfers/new?node=${store}`);
  await page.getByRole('combobox', { name: 'From' }).selectOption(ck);
  await page.getByRole('textbox', { name: 'Request Test Aluminium Foil Roll' }).fill('2');
  await expect(page.getByTestId('unusual-needs')).toContainText('not on the menu');
  await page.getByRole('button', { name: 'Request 1 item' }).click();
  await page.waitForURL(/\/stock\/transfers\/[0-9a-f-]{36}/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: /^Request for material/ })).toBeVisible();
  await expect(page.getByTestId('transfer-progress')).toHaveText('waiting for approval');

  // the store keeper has nothing to issue yet
  await signInAs(page, 'Test Central Kitchen Store Keeper');
  await page.goto('/inbox');
  await expect(page.locator(`a[href^="/stock/transfers/${id}"]`)).toHaveCount(0);

  // the head of Kitchen sees why, and approves from the Inbox
  await signInAs(page, 'Test Head Cook 3.0');
  await page.goto('/inbox');
  const item = page.getByTestId('inbox-item').filter({
    has: page.locator(`a[href^="/stock/transfers/${id}"]`),
  });
  await expect(item).toContainText('Request for material');
  await expect(item.getByTestId('inbox-why')).toContainText('Test Aluminium Foil Roll');
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(item.getByRole('status')).toHaveText('Approved');

  // now it is the store keeper's to issue; reject it so the stock stays where it is
  await signInAs(page, 'Test Central Kitchen Store Keeper');
  await page.goto('/inbox');
  await page.locator(`a[href^="/stock/transfers/${id}"]`).click();
  await expect(page.getByTestId('transfer-progress')).toHaveText('waiting to be sent');
  // rejecting asks why and is confirmed (ADR 053)
  await page.getByRole('button', { name: 'Reject' }).click();
  const why = page.getByTestId('reject-why');
  await why.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Say why' })).toBeVisible();
  await why.getByRole('textbox').fill('Not in stock at the central kitchen');
  await why.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('status')).toHaveText('Rejected.');
});

test('the Account Owner sets the usual quantity in Admin → Settings', async ({ page }) => {
  await signInAs(page, 'Test Account Owner');
  await page.goto('/admin/settings');
  const factor = page.getByLabel('A usual quantity is up to');
  await expect(factor).toHaveValue('1.5');
  await factor.fill('2');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await page.reload();
  await expect(factor).toHaveValue('2');
  await factor.fill('1.5'); // back to the default for the next run
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
});
