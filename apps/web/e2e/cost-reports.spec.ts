import { expect, test } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// The cost controller's reports (R-2, ADR 028) on the test data. The figures are pinned
// by packages/db/src/cost-reports.db.test.ts; here, what people see and tap.

const NO_ACCESS = "You don't have access to this report.";

test('cost of sales: the rupees first, the biggest losses, the formula one tap away', async ({
  page,
}) => {
  await signInAs(page, 'Test Cost Controller 1.0');
  await page.goto('/reports');
  const list = page.getByTestId('report-list');
  for (const name of ['Cost of sales', 'Menu engineering', 'Stock position', 'Purchasing']) {
    await expect(list).toContainText(name);
  }
  await list.getByRole('link', { name: /Cost of sales/ }).click();
  await expect(page.getByRole('heading', { name: 'Cost of sales' })).toBeVisible();
  await expect(page.getByTestId('measure-count_loss').getByTestId('value')).toHaveText('₹1,940');
  await expect(page.getByTestId('measure-beyond_tolerance').getByTestId('value')).toHaveText('1');
  const top = page.getByTestId('top-losses').getByTestId('variance-row');
  await expect(top.first()).toHaveAttribute('data-sku', 'GIN-750ML');
  await expect(page.getByTestId('not-counted')).toContainText('not counted');
  // the formula is behind a tap
  const formula = top.first().getByTestId('formula');
  await expect(formula).toBeHidden();
  await top.first().locator('summary').click();
  await expect(formula).toContainText('= expected');
  // another period
  await page.getByRole('link', { name: 'Yesterday' }).click();
  await expect(page).toHaveURL(/period=yesterday/);
  await expect(page.getByRole('link', { name: 'Yesterday' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('menu engineering: each dish in its group, with what to do about it', async ({ page }) => {
  await signInAs(page, 'Test Cost Controller 1.0');
  await page.goto('/reports/menu');
  const drinks = page.locator('section[data-menu="Bar"]');
  await expect(drinks.getByTestId('class-star')).toContainText('Gin & Tonic');
  await expect(drinks.getByTestId('class-star')).toContainText('Keep them as they are');
  await expect(drinks.getByTestId('class-plowhorse')).toContainText('Lager');
  const food = page.locator('section[data-menu="Food"]');
  await expect(food.getByTestId('class-plowhorse')).toContainText('Butter Naan');
  await expect(food.getByTestId('class-puzzle')).toContainText('Paneer Tikka');
});

test('stock position and purchasing: the executive chef at the Kitchen Store', async ({ page }) => {
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto('/reports/stock');
  await expect(page.getByTestId('viewing')).toHaveText('Test Hotel & Bar 1.0 – Kitchen Store');
  // days on hand need 7 days of use; before 04:00 the business day is still yesterday, one
  // day fewer (ADR 037), and it shows none yet
  const lag = (
    await asMigrator<{ lag: number }>(
      `select (now() at time zone 'Asia/Kolkata')::date - rpt.today($1) as lag`,
      [await placeId('TEST-HOTEL-1.0-KITCHEN-STORE')],
    )
  )[0]!.lag;
  await expect(page.getByTestId('measure-days_on_hand').getByTestId('value')).toContainText(
    lag === 0 ? 'days' : '–',
  );
  // nothing but opening stock in 30 days: dead stock (decided 2 Oct)
  await expect(page.getByTestId('dead-stock').locator('[data-sku="MUTTON"]')).toBeVisible();
  await expect(page.getByTestId('dead-stock').locator('[data-sku="PANEER"]')).toHaveCount(0);

  await page.goto('/reports/purchasing');
  const fill = page.getByTestId('supplier-fill');
  await expect(
    fill.locator('[data-supplier="Test Supplier – Fresh Produce"]').getByTestId('fill'),
  ).toHaveText('95.9% delivered');
  await expect(fill.locator('[data-supplier="Test Supplier – Fresh Produce"]')).toContainText(
    '1 late',
  );
  await expect(
    fill.locator('[data-supplier="Test Supplier – Dairy & Poultry"]').getByTestId('fill'),
  ).toHaveText('0% delivered');
  await expect(page.getByTestId('price-change-total')).toContainText('paid ₹120');
  await expect(page.getByTestId('price-changes').locator('[data-sku="TOMATOES"]')).toHaveCount(2);
});

test('frontline staff open none of them', async ({ page }) => {
  await signInAs(page, 'Test Bartender 1.0');
  for (const path of ['/reports/cost', '/reports/menu', '/reports/stock', '/reports/purchasing']) {
    await page.goto(path);
    await expect(page.locator('main')).toContainText(NO_ACCESS);
  }
  // asking for a store by its id changes nothing
  await page.goto(`/reports/stock?node=${await placeId('TEST-HOTEL-1.0-BAR-STORE')}`);
  await expect(page.locator('main')).toContainText(NO_ACCESS);
});
