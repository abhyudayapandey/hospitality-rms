import { expect, test } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// R-4 (ADR 031) and PO-4 (ADR 032) on the test data: the league table and its CSV, targets
// set by the owner, and sending an order to its supplier. The figures and every refusal are
// pinned by the DB tests (league, settings and po-send); here, what people see and tap.

const NO_ACCESS = "You don't have access to this report.";

async function dairyOrder(): Promise<string> {
  const rows = await asMigrator<{ id: string }>(
    `select po.id from inv.purchase_order po join inv.supplier s on s.id = po.supplier_id
      where s.name = 'Test Supplier – Dairy & Poultry' and po.status = 'released'`,
    [],
  );
  return rows[0]!.id;
}

test('the area manager: outlets side by side, sorted, and as a CSV file', async ({ page }) => {
  await signInAs(page, 'Test Area Manager');
  await page.goto('/reports');
  await expect(page.getByTestId('report-list').getByRole('link').first()).toContainText(
    'Outlets side by side',
  );
  await page.goto('/reports/league');
  const table = page.getByTestId('league');
  for (const code of ['TEST-HOTEL-1.0', 'TEST-HOTEL-1.1', 'TEST-BAR-3.0', 'TEST-GUEST-HOUSE-2.0']) {
    await expect(table.locator(`tr[data-code="${code}"]`)).toBeVisible();
  }
  // the area manager sees labour cost: a people cost figure for Hotel 1.0
  await expect(
    table.locator('tr[data-code="TEST-HOTEL-1.0"] td[data-col="labour_pct"]'),
  ).toContainText('%');
  await page.getByRole('link', { name: /Food cost/ }).click();
  await expect(page).toHaveURL(/sort=food_pct/);

  const href = await page.getByTestId('csv').getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/csv');
  const body = await res.text();
  expect(body).toContain('outlet,sales,food_cost_pct');
  expect(body).toContain('Test Hotel & Bar 1.0');
});

test('staff open neither the league table nor its CSV', async ({ page }) => {
  const area = await placeId('TEST-AREA-MUMBAI');
  await signInAs(page, 'Test Bartender 1.0');
  await page.goto('/reports/league');
  await expect(page.locator('main')).toContainText(NO_ACCESS);
  const res = await page.request.get(`/reports/csv/league?node=${area}&period=week`);
  expect(res.status()).toBe(403);
});

test('the owner sets the targets; a figure worse by more than 2 points shows red', async ({
  page,
}) => {
  await signInAs(page, 'Test Account Owner');
  await page.goto('/admin/settings');
  const food = page.locator('#target-food');
  await expect(food).toHaveValue('30');
  try {
    await food.fill('1');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText('Saved.');
    const area = await placeId('TEST-AREA-MUMBAI');
    await page.goto(`/reports/league?node=${area}`);
    await expect(
      page.locator('tr[data-code="TEST-HOTEL-1.0"] td[data-col="food_pct"]'),
    ).toHaveAttribute('data-target', 'bad');
  } finally {
    // put the default back for the other specs
    await asMigrator(
      `update core.tenant set settings = settings - 'targets' where code = 'TEST-COMPANY'`,
      [],
    );
  }
});

test('the Main Store keeper sends the order they placed on WhatsApp and prints it; the chef follows it', async ({
  page,
}) => {
  const po = await dairyOrder();
  // WhatsApp opens outside the app: answer it here instead
  await page.route('https://wa.me/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>WhatsApp</p>' }),
  );
  // the kitchen's order goes through the Main Store (ADR 049, 052): the chef follows it
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock/orders/${po}`);
  await expect(page.getByTestId('po-progress')).toHaveText('on the way');
  await expect(page.getByTestId('send-card')).toHaveCount(0);

  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/orders/${po}`);
  const card = page.getByTestId('send-card');
  const whatsapp = card.getByRole('button', { name: 'WhatsApp' });
  // quantities only (prices are off by default)
  const link = await whatsapp.getAttribute('data-href');
  expect(link).toMatch(/^https:\/\/wa\.me\/919820010002\?text=/);
  expect(decodeURIComponent(link!)).toContain('Paneer: 5 kg');
  expect(decodeURIComponent(link!)).not.toContain('₹');
  await whatsapp.click();
  await page.waitForURL('https://wa.me/**');

  await page.goto(`/stock/orders/${po}`);
  await expect(page.getByTestId('sends')).toContainText(
    'Sent on WhatsApp by Test Store Keeper 1.0',
  );
  await page.getByTestId('send-card').getByRole('button', { name: 'Print' }).click();
  await expect(page).toHaveURL(new RegExp(`/stock/orders/${po}/print`));
  const sheet = page.getByTestId('printable-order');
  await expect(sheet).toContainText('Test Supplier – Dairy & Poultry');
  await expect(sheet).toContainText('Paneer');
  await expect(sheet).not.toContainText('₹');

  // the supplier's contact, kept by whoever runs the orders
  await page.goto(`/stock/orders/${po}`);
  await page.getByText('Supplier contact').click();
  await expect(page.locator('#supplier-phone')).toHaveValue('+91 98200 10002');
  await page.locator('#supplier-phone').fill('call me');
  await page.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByText(/Check the phone number/)).toBeVisible();
});
