import { expect, test } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// The POS import by the cashier (SAL-2, ADR 039), Push today (INV-12, ADR 040) and every
// report row opening its trend (RPT-12, ADR 041). The import is today's at Test Bar 3.0,
// whose figures no other spec reads for today, with a POS code new on every run, so nothing
// is left matched from a run before.

test.describe.configure({ mode: 'serial' });

const NO_ACCESS = "You don't have access to this report.";
const CODE = `E2E${Date.now() % 1_000_000_000}`;
const DAY = new Date(Date.now() - 6 * 3_600_000).toLocaleDateString('en-CA', {
  timeZone: 'Asia/Kolkata',
});
const [y, m, d] = DAY.split('-');

/** The POS's Sale by item for DAY: two dishes file 23 maps, and one new code. */
const POS_FILE = [
  'Sale by item,,,,,',
  `From ${d}/${m}/${y} To ${d}/${m}/${y},,,,,`,
  'Item,Description,Quantity,Rate,Value,Discount',
  'TEST BAR 3.0,,,,,',
  'Food,,,,,',
  '3001,PANEER TIKKA ........,2.000,355.00,650.00,60.00',
  'Menu Type Total,,2.000,,650.00,60.00',
  'Liquor,,,,,',
  '3022,MOJITO ........,3.000,430.00,1290.00,0.00',
  `${CODE},CHEF SANGRIA SPECIAL,1.000,400.00,400.00,0.00`,
  'Menu Type Total,,4.000,,1690.00,0.00',
  'Restaurant Total,,6.000,,2340.00,60.00',
  'Grand Total,,6.000,,2340.00,60.00',
].join('\r\n');

test('the cashier imports the day and matches the codes not on the menu yet', async ({ page }) => {
  await signInAs(page, 'Test Cashier 3.0');
  // their end-of-day job is on Home, first
  await expect(page.getByTestId('pos-card')).toBeVisible();
  // once: the card, never a tile too (ADR 113)
  await expect(page.getByTestId('tile-posImport')).toHaveCount(0);

  await page.goto(`/menu/sales/import?date=${DAY}`);
  await expect(page.getByTestId('pos-outlet')).toHaveText('Test Bar 3.0');
  await page.getByTestId('pos-file').setInputFiles({
    name: 'Sale by item.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(POS_FILE),
  });
  await expect(page.getByTestId('pos-preview')).toContainText('3 items');
  await expect(page.getByTestId('pos-preview')).toContainText('₹2,340');
  await page.getByTestId('pos-import').click();
  await expect(page.getByRole('status')).toContainText('Imported: 2 items, 1 not matched yet');
  await expect(page.getByTestId('pos-summary')).toContainText('2 items');
  const unmatched = page.getByTestId('pos-unmatched-row');
  await expect(unmatched).toHaveCount(1);
  await expect(unmatched).toContainText('CHEF SANGRIA SPECIAL');

  // matching the codes is part of the cashier's job: pick the dish, post the day again
  await page.getByLabel(`Menu item for ${CODE}`).selectOption({ label: 'House Sangria (glass)' });
  await page.getByTestId('pos-match').click();
  await expect(page.getByText('Matched and posted again: 3 items')).toBeVisible();
  await expect(page.getByTestId('pos-unmatched')).toHaveCount(0);

  // the cashier sees none of the outlet's sales, costs or reports
  await page.goto(`/reports/outlet?node=${await placeId('TEST-BAR-3.0')}`);
  await expect(page.getByText(NO_ACCESS)).toBeVisible();
  await page.goto('/menu/sales');
  await expect(page.getByText("You don't post sales anywhere.")).toBeVisible();
});

test('the bar manager sees the day came from the POS; typing in is closed', async ({ page }) => {
  const bar = await placeId('TEST-BAR-3.0');
  await signInAs(page, 'Test Bar Manager 3.0');
  await page.goto(`/menu/sales/import?node=${bar}&date=${DAY}`);
  await expect(page.getByTestId('pos-summary')).toContainText('3 items');
  await page.goto(`/menu/sales?node=${bar}&date=${DAY}`);
  await expect(page.getByTestId('sales-from-pos')).toContainText('POS import');
  await expect(page.getByTestId('sales-import-link')).toBeVisible();
});

test('Push today: servers see the dishes that use prep expiring by tomorrow', async ({ page }) => {
  // a batch of sugar syrup at Test Bar 3.0's bar store, expiring in 20 hours
  await asMigrator(
    `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                   unit_cost, ref_type, batch_no, expires_at, occurred_at)
     select i.tenant_id, i.id, $1, 'production_in', 500, 0.1, 'production', 'E2E-PUSH',
            now() + interval '20 hours', now() - interval '1 hour'
       from inv.item i join core.hierarchy_node n on n.id = $1 and n.tenant_id = i.tenant_id
      where i.sku = 'SUGAR-SYRUP'`,
    [await placeId('TEST-BAR-3.0-BAR-STORE')],
  );
  await signInAs(page, 'Test Server 3.0');
  const push = page.getByTestId('push-today');
  await expect(push).toBeVisible();
  await expect(push.getByTestId('push-dish').filter({ hasText: 'Mojito' })).toContainText(
    'Sugar Syrup',
  );
  // the kitchen hears through the morning alert, not on Home
  await signInAs(page, 'Test Cook 3.0');
  await expect(page.getByTestId('push-today')).toHaveCount(0);
});

test('every report row opens its trend: a dish, a stock item', async ({ page }) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto(`/reports/menu?node=${hotel}&months=6`);
  await page.locator('[data-testid="dish"][data-code="BUTTER-NAAN"] a').first().click();
  await page.waitForURL(/\/reports\/dish/);
  await expect(page.getByTestId('trend-title')).toHaveText('Butter Naan');
  // the period of menu engineering, by week, as a line
  await expect(
    page.getByRole('navigation', { name: 'Period' }).getByRole('link', { name: '6 months' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('trend-chart')).toHaveAttribute('data-kind', 'line');
  // the weeks are in a section, closed until tapped
  await expect(page.getByTestId('trend-rows')).toBeHidden();
  await page.getByTestId('trend-periods').locator('summary').click();
  await expect(page.getByTestId('trend-rows').locator('li').first()).toContainText('Week of');
  await page.getByRole('link', { name: 'Bars', exact: true }).click();
  await expect(page.getByTestId('trend-chart')).toHaveAttribute('data-kind', 'bar');
  await page.getByRole('link', { name: 'Months', exact: true }).click();
  await page.getByTestId('trend-periods').locator('summary').click();
  await expect(page.getByTestId('trend-rows').locator('li').first()).not.toContainText('Week of');
  await expect(page.getByTestId('trend-chart')).toHaveAttribute('data-kind', 'bar');
  await page.getByRole('link', { name: '12 months' }).click();
  await expect(page.getByTestId('trend-rows').locator('li')).toHaveCount(13);

  // Cost of sales: a row's formula, then its trend
  await page.goto(`/reports/cost?node=${hotel}`);
  const row = page.getByTestId('variance-row').first();
  await row.locator('summary').click();
  await row.getByTestId('item-trend-link').click();
  await page.waitForURL(/\/reports\/item/);
  await expect(page.getByTestId('trend-title')).not.toHaveText('');
  await expect(page.getByTestId('trend-chart')).toBeVisible();

  // Stock position: an item opens the same way
  await page.goto(`/reports/stock?node=${await placeId('TEST-HOTEL-1.0-KITCHEN-STORE')}`);
  await page.locator('[data-sku] a').first().click();
  await page.waitForURL(/\/reports\/item/);
  await expect(page.getByTestId('trend-totals')).toContainText('In stock now');
});

test('every figure on a report opens its trend', async ({ page }) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  await signInAs(page, 'Test General Manager 1.0');
  // Outlet today: food cost over the last 3 months, by week
  await page.goto(`/reports/outlet?node=${hotel}`);
  await page.getByTestId('measure-food_cost_pct').getByTestId('measure-trend-link').click();
  await page.waitForURL(/\/reports\/trend/);
  await expect(page.getByTestId('trend-title')).toHaveText('Food cost');
  await expect(page.getByTestId('trend-chart')).toHaveAttribute('data-kind', 'line');
  // the current week can be empty (a Monday), so look for any week with a figure
  await expect(
    page.getByTestId('trend-rows').locator('li').filter({ hasText: '%' }),
  ).not.toHaveCount(0);
  // people cost too, for the GM who sees it
  await page.goto(`/reports/outlet?node=${hotel}`);
  await page.getByTestId('measure-labour_cost').getByTestId('measure-trend-link').click();
  await expect(page.getByTestId('trend-title')).toHaveText('People cost');
  // the current week can be empty (a Monday), so look for any week with a figure
  await expect(
    page.getByTestId('trend-rows').locator('li').filter({ hasText: '₹' }),
  ).not.toHaveCount(0);

  // Cost of sales, People and Outlets side by side open theirs
  await page.goto(`/reports/cost?node=${hotel}`);
  await page.getByTestId('measure-wastage').getByTestId('measure-trend-link').click();
  await expect(page.getByTestId('trend-title')).toHaveText('Wastage');
  await page.goto(`/reports/people?node=${hotel}`);
  await page.getByTestId('measure-worked_hours').getByTestId('measure-trend-link').click();
  await expect(page.getByTestId('trend-title')).toHaveText('Hours worked');
  // the current week can be empty (a Monday), so look for any week with a figure
  await expect(
    page.getByTestId('trend-rows').locator('li').filter({ hasText: ' h' }),
  ).not.toHaveCount(0);
  // a figure of the moment has no trend
  await page.goto(`/reports/people?node=${hotel}`);
  await expect(
    page.getByTestId('measure-leave_balance_days').getByTestId('measure-trend-link'),
  ).toHaveCount(0);
  // the owner's Outlets side by side: each cell is the outlet's figure
  await signInAs(page, 'Test Account Owner');
  await page.goto(`/reports/league?node=${await placeId('TEST-AREA-MUMBAI')}`);
  await page.locator(`tr[data-code="TEST-HOTEL-1.0"] td[data-col="sales"] a`).click();
  await expect(page.getByTestId('trend-title')).toHaveText('Sales');
});

test("the cost controller: the outlet's figures, never its labour", async ({ page }) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  await signInAs(page, 'Test Cost Controller 1.0');
  await page.goto(`/reports/outlet?node=${hotel}`);
  await expect(page.getByTestId('measure-labour_cost')).toHaveCount(0);
  await page.goto(`/reports/trend?report=outlet_flash&node=${hotel}&measure=labour_cost`);
  await expect(page.getByText(NO_ACCESS)).toBeVisible();
  await page.goto(`/reports/trend?report=outlet_flash&node=${hotel}&measure=sales`);
  await expect(page.getByTestId('trend-chart')).toBeVisible();
});

test('a trend opens only where its report does', async ({ page }) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  const [naan] = await asMigrator<{ id: string }>(
    `select m.id from menu.menu_item m join core.tenant t on t.id = m.tenant_id
      where t.code = 'TEST-COMPANY' and m.code = 'BUTTER-NAAN'`,
    [],
  );
  const [tomatoes] = await asMigrator<{ id: string }>(
    `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
      where t.code = 'TEST-COMPANY' and i.sku = 'TOMATOES'`,
    [],
  );
  await signInAs(page, 'Test Steward 1.0');
  await page.goto(`/reports/dish?node=${hotel}&item=${naan!.id}`);
  await expect(page.getByText(NO_ACCESS)).toBeVisible();
  await page.goto(
    `/reports/item?node=${await placeId('TEST-HOTEL-1.0-KITCHEN-STORE')}&item=${tomatoes!.id}`,
  );
  await expect(page.getByText(NO_ACCESS)).toBeVisible();
});
