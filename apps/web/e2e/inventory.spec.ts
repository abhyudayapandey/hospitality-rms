import { expect, test, type Page } from '@playwright/test';
import { PLACE, placeId, runExecutor, signInAs } from './helpers';

// Test Bar 3.0's Kitchen Store: the head cook keeps it, the Bar Manager runs the outlet,
// the central kitchen store (kept by its store keeper) supplies it.

async function onHand(page: Page, sku: string, node: string): Promise<number> {
  await page.goto(`/stock?node=${node}`);
  const text = await page.locator(`[data-sku="${sku}"] [data-testid="on-hand"]`).textContent();
  return parseFloat(text!.replace(/,/g, ''));
}

test('two-leg transfer: requested, sent by the central kitchen store keeper, received short at the store', async ({
  page,
}) => {
  const store = await placeId(PLACE.store);
  const ck = await placeId(PLACE.centralKitchen);
  await signInAs(page, 'Test Head Cook 3.0');
  const before = await onHand(page, 'POTATOES', store);

  await page.goto(`/stock/transfers/new?node=${store}`);
  const from = page.getByRole('combobox', { name: 'From' });
  // the outlet's other store comes first, then the central kitchen
  await expect(from).toHaveValue(await placeId('TEST-BAR-3.0-BAR-STORE'));
  await from.selectOption(ck);
  await page.getByRole('textbox', { name: 'Request Test Potatoes' }).fill('4');
  await page.getByRole('button', { name: 'Request 1 items' }).click();
  await page.waitForURL(/\/stock\/transfers\/[0-9a-f-]{36}/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByTestId('transfer-progress')).toHaveText('awaiting dispatch');

  await signInAs(page, 'Test Central Kitchen Store Keeper');
  await page.goto('/inbox');
  await page.locator(`a[href^="/stock/transfers/${id}"]`).click();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0); // module only
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText('Sent. It is now in transit.');
  await expect(page.getByTestId('transfer-progress')).toHaveText('in transit');

  // the head cook runs the kitchen store but asked for it (rule 7): the outlet manager receives
  await signInAs(page, 'Test Bar Manager 3.0');
  await page.goto('/inbox');
  await page.locator(`a[href^="/stock/transfers/${id}"]`).click();
  await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0); // in transit
  await page.getByRole('textbox', { name: 'Received Test Potatoes' }).fill('3.5');
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(page.getByRole('status')).toHaveText('Received.');

  await runExecutor(); // inv.transfer.post completes it
  await page.reload();
  await expect(page.getByTestId('transfer-progress')).toHaveText('received');
  // +4 in, -0.5 transit loss
  expect(await onHand(page, 'POTATOES', store)).toBeCloseTo(before + 3.5, 3);
});

test('store to store in one outlet: the main store keeper sends, the kitchen’s keeper receives', async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  const main = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  await signInAs(page, 'Test Sous Chef 1.0');
  const before = await onHand(page, 'BASMATI-RICE', kitchen);

  await page.goto(`/stock/transfers/new?node=${kitchen}`);
  const from = page.getByRole('combobox', { name: 'From' });
  // only this hotel's stores and the central kitchen: never another outlet
  const offered = await from
    .locator('option')
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(offered).not.toContain(await placeId('TEST-HOTEL-1.1-MAIN-STORE'));
  await from.selectOption(main);
  await page.getByRole('textbox', { name: 'Request Test Basmati Rice' }).fill('2');
  await page.getByRole('button', { name: 'Request 1 items' }).click();
  await page.waitForURL(/\/stock\/transfers\/[0-9a-f-]{36}/);
  const id = new URL(page.url()).pathname.split('/').pop()!;

  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto('/inbox');
  await page.locator(`a[href^="/stock/transfers/${id}"]`).click();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('transfer-progress')).toHaveText('in transit');

  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto('/inbox');
  await page.locator(`a[href^="/stock/transfers/${id}"]`).click();
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(page.getByRole('status')).toHaveText('Received.');
  await runExecutor();
  expect(await onHand(page, 'BASMATI-RICE', kitchen)).toBeCloseTo(before + 2, 3);
});

test('a count within tolerance posts straight away', async ({ page }) => {
  const store = await placeId(PLACE.store);
  await signInAs(page, 'Test Head Cook 3.0');
  const before = await onHand(page, 'SALT', store);

  await page.goto(`/stock/count?node=${store}`);
  const resume = page.getByRole('link', { name: /^Continue the count/ });
  if (await resume.count()) await resume.click();
  else await page.getByRole('button', { name: 'Start a count' }).click();
  await page.waitForURL(/\/stock\/count\/[0-9a-f-]{36}/);
  // 2% more than expected: within the 5% tolerance file 11 sets for dry goods
  const counted = Math.round(before * 1.02 * 1000) / 1000;
  await page.getByRole('textbox', { name: 'Counted Test Salt' }).fill(String(counted));
  await page.getByRole('button', { name: /^Submit count/ }).click();
  await expect(page.getByRole('status')).toContainText('1 posted, 0 sent for approval');

  expect(await onHand(page, 'SALT', store)).toBeCloseTo(counted, 3);
});

test('the area manager sees outlet stock read-only (derived view)', async ({ page }) => {
  const store = await placeId(PLACE.store);
  await signInAs(page, 'Test Area Manager');
  await page.goto(`/stock?node=${store}`);
  await expect(page.getByTestId('supply-node')).toHaveText(
    'Test Bar 3.0 – Kitchen Store (view only)',
  );
  await expect(page.getByTestId('stock-row').first()).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Supply' });
  await expect(tabs.getByRole('link', { name: 'Stock' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Count' })).toHaveCount(0);
  await expect(tabs.getByRole('link', { name: 'Wastage' })).toHaveCount(0);
  await page.goto(`/stock/orders?node=${store}`);
  await expect(page.getByRole('link', { name: 'New order' })).toHaveCount(0);
});

test('a department store keeper sees their own store, not the kitchen next door', async ({
  page,
}) => {
  // Hotel 1.0's Bar Manager keeps the Bar Store; the Kitchen Store belongs to the Kitchen
  await signInAs(page, 'Test Bar Manager 1.0');
  await page.goto(`/stock?node=${await placeId('TEST-HOTEL-1.0-BAR-STORE')}`);
  await expect(page.getByTestId('supply-node')).toHaveText('Test Hotel & Bar 1.0 – Bar Store');
  // asking for the Kitchen Store falls back to a store they can see
  await page.goto(`/stock?node=${await placeId('TEST-HOTEL-1.0-KITCHEN-STORE')}`);
  await expect(page.getByTestId('supply-node')).toHaveText('Test Hotel & Bar 1.0 – Bar Store');
  const options = await page
    .getByRole('combobox', { name: 'Location' })
    .locator('option')
    .allTextContents();
  expect(options.filter((o) => o.includes('Kitchen Store'))).toEqual([]);
});
