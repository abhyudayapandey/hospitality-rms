import { expect, test } from '@playwright/test';
import { placeId, signInAs } from './helpers';

// UX audit 3's P2 and P3 findings (ADR 053) through the real screens. The rules are in
// supply-forms.db.test.ts.

test('asking for supplies: nothing filled in, have and keep on each line, says who orders it', async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock/orders/new?node=${kitchen}`);
  // the Main Store orders the kitchen's supplies (F26), and says where to ask for stock (F14)
  await expect(page.getByTestId('who-orders')).toContainText('Main Store orders it');
  await expect(page.getByTestId('who-orders')).toContainText('use Request stock');
  for (const input of await page.getByRole('textbox', { name: /^Quantity / }).all()) {
    await expect(input).toHaveValue('');
  }
  await expect(page.getByTestId('have-keep').first()).toContainText(/^In stock .* · par /);
  // a real button that says what it does; then it clears what it put in (ADR 054)
  const fill = page.getByTestId('fill-to-keep');
  if (await fill.count()) {
    await expect(fill).toHaveText(/^Fill (all \d+|the 1) short items? up to par$/);
    await fill.click();
    await expect(page.getByRole('button', { name: /^Send request · [1-9]/ })).toBeVisible();
    // at most 2 decimals in every box
    for (const input of await page.getByRole('textbox', { name: /^Quantity / }).all()) {
      expect(await input.inputValue()).toMatch(/^(\d+(\.\d{1,2})?)?$/);
    }
    await page.getByRole('button', { name: 'Clear the amounts' }).click();
    await expect(page.getByRole('button', { name: 'Send request · 0 items' })).toBeVisible();
  }

  // a bar with no Main Store orders for itself
  await signInAs(page, 'Test Head Cook 3.0');
  await page.goto(`/stock/orders/new?node=${await placeId('TEST-BAR-3.0-KITCHEN-STORE')}`);
  await expect(page.getByTestId('who-orders')).toContainText('You order it here');
});

test('Send stock shows what the department has and keeps; the Main Store opens on To send', async ({
  page,
}) => {
  const main = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/transfers?node=${main}`);
  await expect(page.getByTestId('tab-send')).toHaveAttribute('aria-current', 'page');
  await page.goto(`/stock/transfers/send?node=${main}&to=${kitchen}`);
  await expect(page.getByTestId('their-stock').first()).toContainText(/^Kitchen Store -?[\d,.]+ /);
  // no quantity shows more than 2 decimals (ADR 054)
  for (const t of await page.getByTestId('their-stock').allTextContents()) {
    expect(t).not.toMatch(/\d\.\d{3}/);
  }
  // the Stock tabs: 4, then More, which shows the rest in the same row and becomes Less
  await expect(page.getByTestId('tabs-more')).toHaveCount(0); // not on this form
  await page.goto(`/stock?node=${main}`);
  const tabs = page.getByRole('navigation', { name: 'Stock tabs' });
  await expect(tabs.getByRole('link', { name: 'Wastage' })).toHaveCount(0);
  await page.getByTestId('tabs-more').click();
  await expect(tabs.getByRole('link', { name: 'Wastage' })).toBeVisible();
  await expect(page.getByTestId('tabs-more')).toHaveText(/^Less/);
  // on a tab from the rest, the row opens already showing them
  await tabs.getByRole('link', { name: 'Bills' }).click();
  await page.waitForURL(/\/stock\/bills/);
  await expect(tabs.getByRole('link', { name: 'Bills' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('tabs-more')).toHaveText(/^Less/);
});

test('back goes to the list as it was, its tab kept', async ({ page }) => {
  const main = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/orders?node=${main}&tab=received`);
  await page.getByTestId('po-item').first().getByRole('link').click();
  await page.waitForURL(/\/stock\/orders\/[0-9a-f-]{36}/);
  await page.getByRole('link', { name: '← Orders' }).click();
  await page.waitForURL(/tab=received/);
  await expect(page.getByTestId('tab-received')).toHaveAttribute('aria-current', 'page');
});

test('the keeper’s Home says running low once, and when a count is due', async ({ page }) => {
  await signInAs(page, 'Test Store Keeper 1.0');
  await expect(page.getByTestId('tile-count')).toContainText(/counted|Never counted/);
  // the Running low tile, not again in Do these first or Needs attention
  await expect(page.getByTestId('tile-low')).toBeVisible();
  await expect(page.getByText(/items? running low/)).toHaveCount(0);
});

test('no access to stock has a way back', async ({ page }) => {
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/stock/bills');
  await expect(page.getByText("You don't have access to stock.")).toBeVisible();
  await page.getByRole('link', { name: '← Home' }).click();
  await page.waitForURL((u) => u.pathname === '/');
});

test('the league table says why an outlet is red, and Home fits a 380 px phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 380, height: 820 });
  await signInAs(page, 'Test Area Manager', { expanded: false });
  const card = page.getByTestId('league-card');
  await expect(card).toBeVisible();
  for (const row of await card.locator('tbody tr[data-tone="bad"]').all()) {
    await expect(row.locator('xpath=following-sibling::tr[1]')).toContainText('target');
  }
  // no sideways scrolling
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
});
