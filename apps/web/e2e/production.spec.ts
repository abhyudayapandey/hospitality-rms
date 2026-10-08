import { expect, test } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Production, daily sales and variance (ADR 015).

test('the sous chef (the kitchen’s lead) records a batch on Make; its label says who made it', async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Sous Chef 1.0');
  await page.goto(`/stock/production?node=${kitchen}`);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Make', exact: true })).toBeVisible();
  await expect(main.getByRole('link', { name: 'Give out what to make' })).toBeVisible();
  await main.getByRole('link', { name: 'Ginger Garlic Paste' }).click();
  await expect(main.getByRole('heading', { name: 'Ginger Garlic Paste' })).toBeVisible();
  await expect(main.getByTestId('shelf-life')).toHaveText(/^Use within \d+ (day|hour)s?$/);
  // half a batch: the ingredients follow
  await main.getByRole('textbox', { name: 'Made' }).fill('500');
  await main.getByRole('button', { name: 'Record batch' }).click();
  await expect(main.getByRole('status')).toHaveText('Batch of Ginger Garlic Paste recorded.');
  // the newest batch is first, with its veg mark and who made it
  const batch = page.getByTestId('batch').first();
  await expect(batch).toContainText('Ginger Garlic Paste');
  await expect(batch).toContainText('Use by');
  await expect(batch).toContainText('made by Test Sous Chef 1.0');
  await expect(batch.getByTestId('food-mark')).toHaveAttribute('data-food', 'veg');
  await batch.getByTestId('label-link').click();
  const label = page.getByTestId('batch-label');
  await expect(label).toContainText('Ginger Garlic Paste');
  await expect(page.getByTestId('label-made-by')).toHaveText('Test Sous Chef 1.0');
  await expect(page.getByTestId('label-batch')).toHaveText(/^\d{8}-\d+$/);
  await expect(page.getByTestId('label-allergens')).toHaveText('No allergens declared');
});

test('a commis makes what he was given: from the task, with its ingredients and method', async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  // his lead gives him Ginger Garlic Paste to make (as the Prep list does)
  const [task] = await asMigrator<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, due_at,
                           assign_mode, assignee_user_id, item_id, target_qty)
     select n.tenant_id, ops.team_of_store(n.id), n.id, 'prep', 'Make Ginger Garlic Paste',
            now() + interval '3 hours', 'person', u.id, i.id, 500
       from core.hierarchy_node n
       join core.app_user u on u.username = 'test.commis.1.0'
       join inv.item i on i.tenant_id = n.tenant_id and i.sku = 'GINGER-GARLIC-PASTE'
      where n.code = 'TEST-HOTEL-1.0-KITCHEN-STORE'
     returning id`,
    [],
  );
  await asMigrator(
    `insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind)
     select tenant_id, id, org_node_id, 1, 'Record the batch', 'batch' from ops.task where id = $1`,
    [task!.id],
  );
  await signInAs(page, 'Test Commis 1.0');
  await page.goto(`/stock/production?node=${kitchen}`);
  const main = page.locator('main');
  // no picker and no form: only what he was given
  await expect(main.getByRole('button', { name: 'Record batch' })).toHaveCount(0);
  await main.getByTestId('make-task').filter({ hasText: 'Ginger Garlic Paste' }).first().click();
  await expect(page.getByTestId('task-title')).toContainText('Ginger Garlic Paste');
  await expect(page.getByTestId('prep-ingredients')).toContainText('Ginger');
  await expect(page.getByTestId('prep-method')).toBeVisible();
  await main.getByRole('textbox', { name: 'Record the batch' }).fill('500');
  await main.getByRole('button', { name: 'Record the batch' }).click();
  await expect(page.getByTestId('task-status')).toHaveText(/^Done/);
  await page.getByTestId('task-label-link').first().click();
  await expect(page.getByTestId('label-made-by')).toHaveText('Test Commis 1.0');
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
