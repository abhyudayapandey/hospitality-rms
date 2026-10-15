import { expect, test, type Page } from '@playwright/test';
import { PLACE, placeId, runExecutor, signInAs, viewing, viewingOptions } from './helpers';

// Test Bar 3.0's Kitchen Store: the head cook keeps it, the Bar Manager runs the outlet,
// the central kitchen store (kept by its store keeper) supplies it.

async function onHand(page: Page, sku: string, node: string): Promise<number> {
  await page.goto(`/stock?node=${node}`);
  const text = await page.locator(`[data-sku="${sku}"] [data-testid="on-hand"]`).textContent();
  return parseFloat(text!.replace(/,/g, ''));
}

test('two-leg transfer: asked, sent by the central kitchen store keeper, received short by whoever asked', async ({
  page,
}) => {
  const store = await placeId(PLACE.store);
  await signInAs(page, 'Test Head Cook 3.0');
  const before = await onHand(page, 'POTATOES', store);

  // nobody picks a store (ADR 115): the outlet's bar keeps no potatoes, the central kitchen does
  await page.goto(`/stock/transfers/new?node=${store}`);
  await expect(page.getByRole('combobox', { name: 'From' })).toHaveCount(0);
  await expect(page.getByTestId('from-Test Central Kitchen – Store')).toContainText(
    'Test Potatoes',
  );
  await page.getByRole('textbox', { name: 'Request Test Potatoes' }).fill('4');
  await page.getByRole('button', { name: 'Request 1 item' }).click();
  await page.waitForURL(/\/stock\/transfers\/[0-9a-f-]{36}/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByTestId('transfer-progress')).toHaveText('waiting to be sent');
  // who asked comes first
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Test Bar 3.0 – Kitchen Store asked Test Central Kitchen – Store',
  );
  // a department's store asking another place is a request for material (ADR 044)
  await expect(page.getByTestId('transfer-kind')).toHaveText('Request');

  await signInAs(page, 'Test Central Kitchen Store Keeper');
  await page.goto('/tasks');
  await page.locator(`a[href^="/stock/transfers/${id}"]`).click();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0); // module only
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText('Sent. It is now in transit.');
  await expect(page.getByTestId('transfer-progress')).toHaveText('in transit');

  // whoever asked receives it (ADR 115): it is a task for them, not a step for someone else
  await signInAs(page, 'Test Head Cook 3.0');
  await page.goto(`/stock/transfers/${id}?node=${store}`);
  await expect(page.getByTestId('request-now')).toContainText('On the way');
  await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0); // in transit
  // one request, one screen (ADR 147): their receive task is done right here
  await page.getByRole('textbox', { name: 'Arrived Test Potatoes' }).fill('3.5');
  await page.getByRole('button', { name: /^Transfer to .* done$/ }).click();
  await expect(page.getByTestId('receive-sent')).toHaveCount(0);

  await runExecutor();
  await page.reload();
  await expect(page.getByTestId('transfer-progress')).toHaveText('received');
  await expect(page.getByTestId('request-story')).toContainText('Received by Test Head Cook 3.0');
  // +4 in, -0.5 transit loss
  expect(await onHand(page, 'POTATOES', store)).toBeCloseTo(before + 3.5, 2);
});

test('store to store in one outlet: the main store keeper sends, whoever asked receives', async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Sous Chef 1.0');
  const before = await onHand(page, 'BASMATI-RICE', kitchen);

  // a store asks for stock from its transfers screen (audit #5: it used to want an outlet)
  await page.goto(`/stock/transfers?node=${kitchen}`);
  await page.getByRole('link', { name: 'Request from a store' }).click();
  await page.waitForURL(/\/stock\/transfers\/new/);
  await expect(page.getByRole('button', { name: 'Add how many you need' })).toBeDisabled();
  // the hotel has a Main Store: everything it keeps is asked of it (ADR 115)
  await expect(page.getByTestId('from-Main Store')).toContainText('Test Basmati Rice');
  await page.getByRole('textbox', { name: 'Request Test Basmati Rice' }).fill('2');
  await page.getByRole('button', { name: 'Request 1 item' }).click();
  await page.waitForURL(/\/stock\/transfers\/[0-9a-f-]{36}/);
  const id = new URL(page.url()).pathname.split('/').pop()!;

  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto('/tasks');
  await page.locator(`a[href^="/stock/transfers/${id}"]`).click();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('transfer-progress')).toHaveText('in transit');

  // whoever asked receives it (ADR 115), on the request
  await signInAs(page, 'Test Sous Chef 1.0');
  await page.goto(`/stock/transfers/${id}?node=${kitchen}`);
  // nothing filled in (ADR 052): a shortfall is counted, not assumed away
  const rice = page.getByRole('textbox', { name: 'Arrived Test Basmati Rice' });
  await expect(rice).toHaveValue('');
  const done = page.getByRole('button', { name: /^Transfer to .* done$/ });
  await done.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Enter what arrived of Test Basmati Rice' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Everything arrived' }).click();
  await expect(rice).toHaveValue('2');
  await done.click();
  await expect(page.getByTestId('receive-sent')).toHaveCount(0);
  await runExecutor();
  expect(await onHand(page, 'BASMATI-RICE', kitchen)).toBeCloseTo(before + 2, 2);
});

test('a count within tolerance posts straight away', async ({ page }) => {
  const store = await placeId(PLACE.store);
  await signInAs(page, 'Test Head Cook 3.0');
  const before = await onHand(page, 'SALT', store);

  await page.goto(`/stock/count?node=${store}`);
  const resume = page.getByRole('link', { name: /^Continue the count/ });
  if (await resume.count()) await resume.click();
  else await page.getByRole('button', { name: 'Start a stock check' }).click();
  await page.waitForURL(/\/stock\/count\/[0-9a-f-]{36}/);
  // 2% more than expected: within the 5% tolerance file 11 sets for dry goods
  const counted = Math.round(before * 1.02 * 1000) / 1000;
  await page.getByRole('textbox', { name: 'Counted Test Salt' }).fill(String(counted));
  await page.getByRole('button', { name: /^Submit count/ }).click();
  await expect(page.getByRole('status')).toContainText('1 posted, 0 sent for approval');

  // the screen shows 2 decimals (ADR 054)
  expect(await onHand(page, 'SALT', store)).toBeCloseTo(counted, 2);
});

test('the area manager sees outlet stock read-only (derived view)', async ({ page }) => {
  const store = await placeId(PLACE.store);
  await signInAs(page, 'Test Area Manager');
  await page.goto(`/stock?node=${store}`);
  await expect.poll(() => viewing(page)).toBe('Test Bar 3.0 – Kitchen Store (view only)');
  await expect(page.getByTestId('stock-row').first()).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Stock tabs' });
  await expect(tabs.getByRole('link', { name: 'Stock', exact: true })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Stock check', exact: true })).toHaveCount(0);
  await expect(tabs.getByRole('link', { name: 'Wastage' })).toHaveCount(0);
  await page.goto(`/stock/orders?node=${store}`);
  // the create button, not an order row still waiting for its supplier
  await expect(page.getByRole('link', { name: 'Request to buy', exact: true })).toHaveCount(0);
});

test('a department store keeper sees their own store, not the kitchen next door', async ({
  page,
}) => {
  // Hotel 1.0's Bar Manager keeps the Bar Store; the Kitchen Store belongs to the Kitchen
  await signInAs(page, 'Test Bar Manager 1.0');
  await page.goto(`/stock?node=${await placeId('TEST-HOTEL-1.0-BAR-STORE')}`);
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – Bar Store');
  // asking for the Kitchen Store falls back to a store they can see
  await page.goto(`/stock?node=${await placeId('TEST-HOTEL-1.0-KITCHEN-STORE')}`);
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – Bar Store');
  // one store: a plain label, no picker
  await expect.poll(() => viewingOptions(page)).toEqual([]);
});
