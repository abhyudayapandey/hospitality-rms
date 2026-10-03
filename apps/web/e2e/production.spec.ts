import { expect, test } from '@playwright/test';
import { placeId, signInAs } from './helpers';

// Production, daily sales and variance (ADR 015).

test('a chef de partie records a batch where it is made; it shows with its expiry', async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Chef de Partie 1.0');
  await page.goto(`/stock/production?node=${kitchen}`);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Production' })).toBeVisible();
  await main.getByRole('link', { name: 'Ginger Garlic Paste' }).click();
  await expect(main.getByRole('heading', { name: 'Ginger Garlic Paste' })).toBeVisible();
  await expect(main.getByTestId('shelf-life')).toHaveText(/^Use within \d+ (day|hour)s?$/);
  // half a batch: the ingredients follow
  await main.getByRole('textbox', { name: 'Made' }).fill('500');
  await main.getByRole('button', { name: 'Record batch' }).click();
  await expect(main.getByRole('status')).toHaveText('Batch of Ginger Garlic Paste recorded.');
  await expect(
    page.getByTestId('batch').filter({ hasText: 'Ginger Garlic Paste' }).first(),
  ).toContainText('Use within');
});

test('a bartender posts no sales', async ({ page }) => {
  await signInAs(page, 'Test Bartender 1.0');
  await page.goto('/menu/sales');
  await expect(page.locator('main')).toContainText("You don't post sales anywhere.");
  await page.goto('/menu/recipes');
  await expect(
    page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: 'Sales' }),
  ).toHaveCount(0);
});

test('the general manager posts a day’s bar sales; stock goes below zero and the bar’s store keeper sees it', async ({
  page,
}) => {
  const bar = await placeId('TEST-HOTEL-1.0-BAR-STORE');
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/menu/sales');
  const main = page.locator('main');
  await expect(page.getByTestId('sales-outlet')).toHaveText('Test Hotel & Bar 1.0');
  // far more gin and tonics than there are tonic cans: the sale is never blocked
  await main.getByRole('textbox', { name: 'Sold Gin & Tonic' }).fill('400');
  await main.getByRole('button', { name: "Save the day's sales" }).click();
  await expect(main.getByRole('status')).toContainText('stock is updated');

  await signInAs(page, 'Test Bar Manager 1.0');
  await page.goto('/notifications');
  await expect(page.locator('main')).toContainText('Stock below zero after sales');
  await page.goto(`/stock?node=${bar}`);
  await expect(
    page.locator('[data-sku="TONIC-WATER-300ML"] [data-testid="below-zero"]'),
  ).toBeVisible();
});

test('the cost controller reads cost of sales for the outlet; Variance leads there', async ({
  page,
}) => {
  await signInAs(page, 'Test Cost Controller 1.0');
  await page.goto('/menu/variance');
  await page.waitForURL('**/reports/cost');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Cost of sales' })).toBeVisible();
  await expect(page.getByTestId('measure-bar_cost_pct')).toBeVisible();
  await expect(page.getByTestId('variance-row').first()).toBeVisible();
});
