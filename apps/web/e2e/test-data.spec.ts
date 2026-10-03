import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

// The test-only activity files 25 to 28 (ADR 017) as people see them in the app. The
// figures themselves are pinned by packages/db/src/test-data-activity.db.test.ts.

test('the GM sees the closing count on Cost of sales: gin highlighted, vodka within tolerance', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/reports/cost');
  await expect(page.getByTestId('viewing')).toHaveText('Test Hotel & Bar 1.0');
  const top = page.getByTestId('top-losses');
  const gin = top.locator('[data-testid="variance-row"][data-sku="GIN-750ML"]');
  await expect(gin).toHaveClass(/bg-rose-50/);
  await expect(gin).toContainText('₹1,800');
  const vodka = top.locator('[data-testid="variance-row"][data-sku="VODKA-750ML"]');
  await expect(vodka).not.toHaveClass(/bg-rose-50/);
  // the cost % (pinned by the DB tests; other e2e tests sell and waste today)
  await expect(page.getByTestId('measure-bar_cost_pct').getByTestId('value')).toContainText('%');
  await expect(page.getByTestId('measure-food_cost_pct').getByTestId('value')).toContainText('%');
});

test('a second commis sees their two published weeks of dinner shifts', async ({ page }) => {
  await signInAs(page, 'Test Commis B 1.0');
  await page.goto('/roster/my');
  const shifts = page
    .getByTestId('my-shifts-upcoming')
    .locator('[data-testid="shift-row"][data-kind="shift"]');
  await expect(shifts).toHaveCount(10); // Wed to Sun, two weeks (file 25)
  await expect(shifts.first()).toContainText('commis');
});
