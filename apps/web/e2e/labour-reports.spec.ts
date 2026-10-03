import { expect, test } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Labour cost, the cost breakdown, People and the central kitchen (R-3, ADR 030) on the
// test data. The figures are pinned by packages/db/src/labour-reports.db.test.ts; here, who
// sees what.

const NO_ACCESS = "You don't have access to this report.";

test('the GM: people cost and prime cost on Outlet today, by department on Cost of sales', async ({
  page,
}) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  // the same day as the DB test: days in the test data count from the load date
  const day = (await asMigrator<{ day: string }>('select (current_date - 2)::text as day', []))[0]!
    .day;
  await signInAs(page, 'Test General Manager 1.0');
  // two days back: the test attendance and salaried pay (labour-reports.db.test.ts)
  await page.goto(`/reports/outlet?node=${hotel}&day=${day}`);
  await expect(page.getByTestId('measure-labour_cost').getByTestId('value')).toHaveText('₹69,025');
  const parts = page.getByTestId('cost-breakdown');
  await expect(parts.getByTestId('part-materials')).toBeVisible();
  await expect(parts.getByTestId('part-labour').getByTestId('value')).toHaveText('₹69,025');
  await expect(parts.getByTestId('part-prime')).toBeVisible();

  await page.goto('/reports/cost');
  await expect(page.getByTestId('cost-breakdown').getByTestId('part-labour')).toBeVisible();
  const depts = page.getByTestId('labour-by-department');
  await expect(depts).toContainText('Kitchen');
  await expect(depts.locator('[data-part="other"]')).toContainText('Other departments');
  // a department under 3 paid people is never shown on its own
  await expect(depts).not.toContainText('Security');
});

test('the executive chef and the cost controller: the cost breakdown without people', async ({
  page,
}) => {
  await signInAs(page, 'Test Cost Controller 1.0');
  await page.goto('/reports/cost');
  const parts = page.getByTestId('cost-breakdown');
  await expect(parts.getByTestId('part-materials')).toBeVisible();
  await expect(parts.getByTestId('part-labour')).toHaveCount(0);
  await expect(page.getByTestId('labour-by-department')).toHaveCount(0);

  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto('/reports/department');
  await expect(page.getByTestId('measure-worked_hours')).toBeVisible();
  await expect(page.getByTestId('measure-labour_cost')).toHaveCount(0);
});

test('People: the HR executive in days, the HR admin in rupees', async ({ page }) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  await signInAs(page, 'Test HR Executive 1.0');
  await page.goto('/reports');
  await expect(page.getByTestId('report-list')).toContainText('People');
  await page.goto('/reports/people');
  await expect(page.getByTestId('measure-headcount').getByTestId('value')).toHaveText('42');
  await expect(page.getByTestId('measure-leave_balance_days')).toBeVisible();
  await expect(page.getByTestId('measure-leave_liability')).toHaveCount(0);
  await expect(page.getByTestId('people-leave')).not.toContainText('₹');

  await signInAs(page, 'Test HR Admin');
  await page.goto(`/reports/people?node=${hotel}`);
  await expect(page.getByTestId('measure-leave_liability').getByTestId('value')).toContainText('₹');
});

test('Central kitchen: the manager and the store keeper; not the chef', async ({ page }) => {
  const bar = await placeId('TEST-BAR-3.0-KITCHEN-STORE');
  const hotel = await placeId('TEST-HOTEL-1.1-KITCHEN-STORE');
  await signInAs(page, 'Test Central Kitchen Manager');
  await page.goto('/reports/kitchen');
  await expect(page.getByTestId('kitchen-production')).toContainText('Onion Tomato Masala');
  const sent = page.getByTestId('kitchen-dispatch');
  await expect(sent.locator(`[data-store="${hotel}"]`).getByTestId('fill')).toHaveText(
    '90.0% filled',
  );
  await expect(sent.locator(`[data-store="${hotel}"]`)).toContainText('lost on the way');
  await expect(sent.locator(`[data-store="${bar}"]`).getByTestId('fill')).toHaveText(
    '100.0% filled',
  );
  await expect(page.getByTestId('kitchen-in-transit')).toContainText('Bar 3.0');

  await signInAs(page, 'Test Central Kitchen Store Keeper');
  await page.goto('/reports');
  await expect(page.getByTestId('report-list')).toContainText('Central kitchen');

  await signInAs(page, 'Test Central Kitchen Chef');
  await page.goto('/reports/kitchen');
  await expect(page.locator('main')).toContainText(NO_ACCESS);
});

test('the Hotel 1.1 executive chef: what came from the central kitchen', async ({ page }) => {
  const store = await placeId('TEST-HOTEL-1.1-KITCHEN-STORE');
  await signInAs(page, 'Test Executive Chef 1.1');
  await page.goto(`/reports/purchasing?node=${store}`);
  const came = page.getByTestId('transfers-in');
  await expect(came).toContainText('Test Central Kitchen');
  await expect(came.getByTestId('fill')).toHaveText('85.0% received');
});

test('frontline staff open neither People nor the central kitchen', async ({ page }) => {
  await signInAs(page, 'Test Bartender 1.0');
  for (const path of ['/reports/people', '/reports/kitchen']) {
    await page.goto(path);
    await expect(page.locator('main')).toContainText(NO_ACCESS);
  }
  await page.goto(`/reports/people?node=${await placeId('TEST-HOTEL-1.0')}`);
  await expect(page.locator('main')).toContainText(NO_ACCESS);
});
