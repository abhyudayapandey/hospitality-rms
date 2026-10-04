import { expect, test } from '@playwright/test';
import { placeId, signInAs } from './helpers';

// What is behind a figure (ADR 042): a figure's trend opens the weeks and the lists behind
// the picked week, each in a section closed until tapped. The sums are pinned by
// packages/db/src/report-breakdowns.db.test.ts; here, what shows and to whom.

const trendOf = async (
  page: import('@playwright/test').Page,
  node: string,
  measure: string,
  report = 'outlet',
) => {
  await page.goto(`/reports/${report}?node=${node}`);
  await page.getByTestId(`measure-${measure}`).getByTestId('measure-trend-link').click();
  await page.waitForURL(/\/reports\/trend/);
};

test('the GM: stock by item, people by name, tasks by person; all closed until tapped', async ({
  page,
}) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  await signInAs(page, 'Test General Manager 1.0');

  // Stock value: the items held now, biggest first
  await trendOf(page, hotel, 'stock_value');
  await expect(page.getByTestId('breakdown-period')).toContainText('Week of');
  const stock = page.getByTestId('breakdown-stock');
  await expect(stock.getByTestId('bd-stock')).toBeHidden();
  await expect(stock.locator('summary')).toContainText('items · ₹');
  await stock.locator('summary').click();
  await expect(stock.getByTestId('bd-stock').locator('li').first()).toContainText('of stock');

  // Hours worked: each person's shifts, hours, late and no-shows
  await trendOf(page, hotel, 'worked_hours');
  const people = page.getByTestId('breakdown-people');
  await people.locator('summary').click();
  await expect(people.getByTestId('bd-people').locator('li').first()).toContainText('worked');

  // Tasks due: each person's on-time %, due and overdue
  await trendOf(page, hotel, 'tasks_due');
  const tasks = page.getByTestId('breakdown-tasks');
  await expect(tasks.locator('summary')).toContainText('due');
  await tasks.locator('summary').click();
  await expect(tasks.getByTestId('bd-tasks').locator('li').first()).toContainText('on time');

  // picking an earlier week moves the lists to that week
  await page.getByTestId('trend-periods').locator('summary').click();
  const earlier = page.getByTestId('trend-rows').locator('li').nth(1);
  const label = (await earlier.locator('span.font-medium').innerText()).trim();
  await earlier.getByRole('link').click();
  await expect(page.getByTestId('breakdown-period')).toContainText(label);

  // People cost %: where the money went in that week, as shares of the total cost
  await trendOf(page, hotel, 'labour_pct');
  await expect(page.getByTestId('trend-title')).toHaveText('People cost %');
  const cost = page.getByTestId('breakdown-cost');
  await cost.locator('summary').click();
  await expect(cost.getByTestId('part-prime')).toContainText('100.0%');
});

test('the owner: wastage by item, how much, what it cost, why', async ({ page }) => {
  // the test data's wastage is a transit loss at Hotel 1.1
  const hotel = await placeId('TEST-HOTEL-1.1');
  await signInAs(page, 'Test Account Owner');
  await page.goto(`/reports/trend?report=outlet_flash&node=${hotel}&measure=wastage`);
  // the latest week with wastage is picked
  const waste = page.getByTestId('breakdown-wastage');
  await expect(waste.locator('summary')).toContainText('1 item · ₹16');
  await waste.locator('summary').click();
  await expect(waste.getByTestId('bd-wastage')).toContainText('Lost in transit');
});

test('the cost controller: the totals, without the names behind them', async ({ page }) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  await signInAs(page, 'Test Cost Controller 1.0');
  await trendOf(page, hotel, 'late');
  const people = page.getByTestId('breakdown-people');
  await expect(people.locator('summary')).toContainText('Names not shown');
  await people.locator('summary').click();
  await expect(people.getByTestId('bd-people')).toHaveCount(0);
});
