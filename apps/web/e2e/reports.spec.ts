import { expect, test } from '@playwright/test';
import { placeId, signInAs } from './helpers';

// Home is "Today" (UX-2) and the first reports (R-1, ADR 023), through the real screens.
// Who may open what is proved for every user in reports-access.db.test.ts; these check
// that the screens follow it: a server sees only their own week, the GM the outlet, the
// executive chef the Kitchen, the owner every outlet, read-only.

const NO_ACCESS = "You don't have access to this report.";

test('a server: only My week; the outlet and department reports refuse', async ({ page }) => {
  await signInAs(page, 'Test Server 3.0');
  await expect(page.getByTestId('numbers-card')).toHaveCount(0);
  await expect(page.getByTestId('attention-card')).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'More' })
    .getByRole('link', { name: 'My week' })
    .click();
  await expect(page.getByRole('heading', { name: 'My week' })).toBeVisible();
  await expect(page.getByTestId('report-week')).toHaveText('This week');
  await expect(page.getByTestId('measure-shifts')).toBeVisible();

  await page.goto('/reports');
  await expect(page.getByTestId('report-list').getByRole('link')).toHaveCount(1);
  await expect(page.getByTestId('report-list')).toContainText('My week');
  for (const path of ['/reports/outlet', '/reports/department']) {
    await page.goto(path);
    await expect(page.locator('main')).toContainText(NO_ACCESS);
  }
  // even asked for the outlet by id
  await page.goto(`/reports/outlet?node=${await placeId('TEST-BAR-3.0')}`);
  await expect(page.locator('main')).toContainText(NO_ACCESS);
  await expect(page.locator('main')).not.toContainText('₹');
});

test('the GM: today’s numbers on Home, the outlet report, yesterday', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0');
  const numbers = page.getByTestId('numbers-card');
  await expect(numbers).toContainText('Test Hotel & Bar 1.0');
  await expect(numbers.getByTestId('tile-sales')).toContainText('₹');
  await numbers.getByRole('link', { name: 'Open the report' }).click();
  await expect(page.getByRole('heading', { name: 'Outlet today' })).toBeVisible();
  await expect(page.getByTestId('report-day')).toHaveText('Today so far');
  await page.getByRole('link', { name: 'Day before' }).click();
  await expect(page.getByTestId('report-day')).toHaveText('Yesterday');
  // the test data sells the same every day (file 27): ₹24,195, food cost 21.5%
  await expect(page.getByTestId('measure-sales').getByTestId('value')).toHaveText('₹24,195');
  await expect(page.getByTestId('measure-food_cost_pct').getByTestId('value')).toHaveText('21.5%');

  await page.goto('/reports');
  await expect(page.getByTestId('report-list')).toContainText('Outlet today');
  await expect(page.getByTestId('report-list')).toContainText('Department today');
  await expect(page.getByTestId('report-list')).toContainText('My week');
});

test('the executive chef: the Kitchen today, not the outlet', async ({ page }) => {
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto('/reports/department');
  await expect(page.getByTestId('viewing')).toHaveText('Test Hotel & Bar 1.0 – Kitchen');
  await expect(page.getByRole('heading', { name: 'On shift today' })).toBeVisible();
  await expect(page.getByTestId('measure-scheduled_hours')).toBeVisible();
  // the Kitchen Store's figures: the chef keeps that store
  await expect(page.getByTestId('measure-stock_value')).toContainText('₹');
  await page.goto('/reports/outlet');
  await expect(page.locator('main')).toContainText(NO_ACCESS);
});

test('the Account Owner: Reports in the nav, every outlet, read-only', async ({ page }) => {
  await signInAs(page, 'Test Account Owner');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Reports' })
    .click();
  await page
    .getByTestId('report-list')
    .getByRole('link', { name: /Outlet today/ })
    .click();
  const picker = page.getByRole('combobox', { name: 'Place' });
  await expect(picker.locator('option')).toHaveCount(4);
  await expect(page.getByTestId('measure-sales')).toBeVisible();
  // nothing to change on a report
  await expect(page.locator('main').getByRole('button')).toHaveCount(0);
});

test('the cost controller: Reports instead of Menu, Menu one tap away', async ({ page }) => {
  await signInAs(page, 'Test Cost Controller 1.0');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Reports' })
    .click();
  await page.getByRole('link', { name: 'Menu costs and prices' }).click();
  await expect(page.getByRole('heading', { name: 'Menu costs' })).toBeVisible();
});

test('Home for a commis: their tasks, at most four shortcuts, the rest under All screens', async ({
  page,
}) => {
  await signInAs(page, 'Test Commis 1.0');
  await expect(page.getByTestId('tasks-card')).toBeVisible();
  await expect(page.getByTestId('numbers-card')).toHaveCount(0);
  const shortcuts = page.getByRole('navigation', { name: 'More' }).getByRole('link');
  expect(await shortcuts.count()).toBeLessThanOrEqual(4);
});
