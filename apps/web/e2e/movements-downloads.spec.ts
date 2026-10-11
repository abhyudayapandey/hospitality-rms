import { expect, test, type Page } from '@playwright/test';
import { placeId, signInAs } from './helpers';

// Stock movements (ADR 122) and a list's days and download (ADR 120), at 380 px on Test Hotel
// 1.0: the GM sees file 33's orders and receipts for all the hotel's stores, opens one to its
// items and downloads the list; Orders narrows to chosen days, goes back to all of them and
// downloads what it shows. Who opens what is in stock-movements.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('the GM: every order, receipt and transfer of the hotel, for any days', async ({ page }) => {
  const hotel = await placeId('TEST-HOTEL-1.0-SUPPLY');
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/reports');
  await main(page)
    .getByRole('link', { name: /Stock movements/ })
    .click();
  await page.waitForURL(/\/reports\/movements/);
  // the last 40 days hold file 33's four orders
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
  await page.goto(`/reports/movements?node=${hotel}&period=custom&from=${from}&to=${to}`);
  await expect(main(page).getByTestId('tab-ordered')).toContainText('(4)');
  await main(page).getByTestId('total-ordered').click();
  await page.waitForURL(/tab=ordered/);
  const rows = main(page).getByTestId('movement');
  await expect(rows).toHaveCount(4);
  await rows.first().locator('summary').click();
  await expect(rows.first().getByTestId('item-pictures').first()).toBeVisible();
  const res = await page.request.get(
    `/reports/csv/movements?node=${hotel}&period=custom&from=${from}&to=${to}`,
  );
  expect(res.status()).toBe(200);
  expect((await res.text()).split('\n')[0]).toContain('day,kind,store');
});

test('a list narrows to chosen days, goes back to all of them, and downloads', async ({ page }) => {
  const store = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock/orders?node=${store}`);
  const all = await main(page).getByTestId('po-item').count();
  expect(all).toBeGreaterThan(0);
  // a day long before the test data: nothing
  await page.goto(`/stock/orders?node=${store}&from=2020-01-01&to=2020-01-31`);
  await expect(main(page).getByTestId('po-item')).toHaveCount(0);
  await expect(main(page).getByTestId('list-days')).toContainText('to');
  // the tabs keep the days
  await expect(main(page).getByTestId('tab-all')).toHaveAttribute('href', /from=2020-01-01/);
  await main(page).getByTestId('all-dates').click();
  await page.waitForURL((u) => !u.search.includes('from='));
  await expect(main(page).getByTestId('po-item')).toHaveCount(all);
  const download = main(page).getByTestId('export-orders');
  const res = await page.request.get((await download.getAttribute('href'))!);
  expect(res.status()).toBe(200);
  const csv = await res.text();
  expect(csv.split('\n')[0]).toContain('placed_at,store,supplier');
  expect(csv.trim().split('\n').length - 1).toBe(all);
  // another customer's store is not theirs to download
  const solo = await placeId('TEST-SOLO-BAR-BAR-STORE');
  expect((await page.request.get(`/export/orders?node=${solo}`)).status()).toBe(403);
});
