import { expect, test } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Vendor bills (BIL-1 to BIL-3, ADR 050) through the real screens. There is no photo bucket in
// this environment, so a file cannot be uploaded here: the form says so, and the bill the GM
// reads is put in place as the migrator. Who may add and see bills, the files and the order's
// store are in vendor-bills.db.test.ts.

test('the store keeper opens the service bill form; without storage it says so instead of saving', async ({
  page,
}) => {
  const main = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/bills?node=${main}`);
  await expect(page.getByRole('heading', { name: 'Bills' })).toBeVisible();
  await page.getByRole('link', { name: 'Add a bill for a service' }).click();
  await page.waitForURL('**/stock/bills/new**');
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption('other');
  await page.getByRole('textbox', { name: 'Supplier name' }).fill('Pest Co');
  await page.getByRole('textbox', { name: 'What was it for?' }).fill('Pest control, October');
  await page.getByRole('textbox', { name: 'Amount (₹)' }).fill('900');
  await page.getByRole('button', { name: 'Save the bill' }).click();
  await expect(page.getByTestId('bill-form').getByRole('alert')).toHaveText(
    'Add a photo or PDF of the bill.',
  );
  await page.getByLabel('Bill photo or PDF').setInputFiles({
    name: 'bill.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
  });
  await expect(page.getByTestId('bill-form').getByRole('alert')).toHaveText('Uploads are off.');
});

test('the GM sees every bill across the stores, opens one and archives it with a reason', async ({
  page,
}) => {
  const main = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  const what = `Linen washing ${Date.now()}`;
  const [bill] = await asMigrator<{ id: string }>(
    `insert into inv.bill (tenant_id, delivery_node_id, kind, supplier_name, bill_no, bill_date,
                           amount, description, files, created_by)
     select n.tenant_id, n.id, 'service', 'Clean Linen Co', 'LW-9', current_date, 4250.50, $2,
            array['bills/' || n.tenant_id || '/' || n.id || '/' || gen_random_uuid() || '.pdf'],
            (select id from core.app_user where display_name = 'Test Store Keeper 1.0')
       from core.hierarchy_node n where n.id = $1
     returning id`,
    [main, what],
  );

  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/stock/bills?all=1&tab=services');
  const row = page.getByTestId('bill-item').filter({ hasText: what });
  await expect(row).toContainText('Clean Linen Co');
  await expect(row).toContainText('₹4,250.50');
  await expect(row).toContainText('Main Store');
  await row.getByRole('link').click();
  await page.waitForURL(`**/stock/bills/${bill!.id}**`);
  await expect(page.getByTestId('bill')).toContainText('No. LW-9');
  await expect(page.getByTestId('bill')).toContainText('Added by Test Store Keeper 1.0');

  await page.getByRole('button', { name: 'This bill is wrong' }).click();
  await page.getByRole('textbox', { name: /^Why\?/ }).fill('Added twice');
  await page.getByRole('button', { name: 'Archive the bill' }).click();
  await page.waitForURL(/\/stock\/bills\?node=/);
  await page.goto('/stock/bills?all=1&tab=services');
  await expect(page.getByTestId('bill-item').filter({ hasText: what })).toHaveCount(0);
});

test('orders received without a bill wait for one, and their order asks for it', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/stock/bills?all=1&tab=waiting');
  const waiting = page.getByTestId('bill-waiting');
  await expect(waiting.first()).toBeVisible();
  await waiting.first().getByRole('link').click();
  await page.waitForURL(/\/stock\/orders\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('po-bills').getByText('Add the bill')).toBeVisible();
  await expect(page.getByTestId('bill-form')).toBeVisible();
  // a bill for goods takes the order's supplier: no supplier or "what for" questions
  await expect(
    page.getByTestId('bill-form').getByRole('textbox', { name: 'What was it for?' }),
  ).toHaveCount(0);
});

test('a department head with no store has no Bills', async ({ page }) => {
  await signInAs(page, 'Test Chief Engineer 1.0');
  await page.goto('/stock/bills');
  await expect(page.getByText("You don't have access to stock.")).toBeVisible();
});
