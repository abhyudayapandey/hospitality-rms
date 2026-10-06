import { expect, test, type Page } from '@playwright/test';
import { asMigrator, runPlatformWorker, signInPlatform } from './helpers';

// An outlet from a template in the Platform Admin console (ADR 062), through the real
// screens and the real worker: a new customer, then "Café" with delivery orders; the review
// says what it adds, and the dry run and apply load it.

test.use({ viewport: { width: 380, height: 900 } });

async function workerFinishes(page: Page) {
  await expect(page.getByTestId('job-status')).toHaveText('queued');
  runPlatformWorker();
  await expect(page.getByTestId('job-status')).toHaveText('done'); // the page polls
}

test('a new customer gets a café from the template, with its checklists and stores', async ({
  page,
}) => {
  const code = `E2E-CAFE-${Date.now().toString(36).toUpperCase()}`;
  await signInPlatform(page);
  await page.goto('/platform');
  await page.getByRole('link', { name: 'New customer' }).click();
  const form = page.getByRole('form', { name: 'New customer' });
  await form.getByLabel('Company name').fill(`E2E Cafés ${code}`);
  await form.getByLabel('Customer code').fill(code);
  await form.getByLabel('Owner name').fill('Asha Rao');
  await form.getByRole('button', { name: `Use suggested: ${code.toLowerCase()}.owner` }).click();
  await form.getByLabel('Owner email').fill(`${code.toLowerCase()}@example.test`);
  await form.getByRole('button', { name: 'Create customer' }).click();
  await page
    .getByRole('dialog', { name: 'Confirm the first account owner' })
    .getByRole('button', { name: 'Confirm and create' })
    .click();
  await page.waitForURL(/\/platform\/jobs\/[0-9a-f-]{36}/);
  await workerFinishes(page);

  await page.goto('/platform');
  await page.locator(`[data-code="${code}"]`).getByRole('link').first().click();
  await page.getByRole('link', { name: 'Add an outlet' }).click();
  // what it is, in the words people use
  await page.getByTestId('tiles').getByRole('link', { name: /Café/ }).click();
  const outlet = page.getByRole('form', { name: 'The outlet' });
  // a café: kitchen and counter ticked; the dining room offered under "Also in a restaurant"
  const depts = outlet.getByTestId('departments');
  await expect(depts.getByRole('checkbox', { name: 'Counter' })).toBeChecked();
  await expect(depts.getByText('Also in a restaurant')).toBeVisible();
  await expect(depts.getByRole('checkbox', { name: 'Restaurant' })).not.toBeChecked();
  await outlet.getByLabel('Name', { exact: true }).fill('Bandra Café');
  await outlet.getByLabel(/Short code/).fill(`${code}-BANDRA`);
  await outlet.getByRole('checkbox', { name: /Takes delivery orders/ }).check();
  await outlet.getByRole('button', { name: 'See what it adds' }).click();

  const review = page.getByTestId('review');
  await expect(review).toContainText('Kitchen (Kitchen Store), Counter');
  await expect(review).toContainText('Barista');
  await expect(review).toContainText('Delivery packing');
  await review.getByRole('button', { name: 'Add and dry run' }).click();
  await page.waitForURL(/\/platform\/jobs\/[0-9a-f-]{36}$/);
  await workerFinishes(page);
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL(/\/platform\/jobs\//);
  await workerFinishes(page);

  const places = await asMigrator<{ code: string; outlet_format: string | null }>(
    `select n.code, n.outlet_format from core.hierarchy_node n join core.tenant t on t.id = n.tenant_id
      where t.code = $1 and n.code like $2 || '%' order by 1`,
    [code, `${code}-BANDRA`],
  );
  expect(places.map((p) => p.code)).toEqual(
    expect.arrayContaining([
      `${code}-BANDRA`,
      `${code}-BANDRA-COUNTER`,
      `${code}-BANDRA-KITCHEN`,
      `${code}-BANDRA-KITCHEN-STORE`,
      `${code}-BANDRA-SUPPLY`,
    ]),
  );
  expect(places.find((p) => p.code === `${code}-BANDRA`)?.outlet_format).toBe('restaurant');
  const lists = await asMigrator<{ library_code: string }>(
    `select c.library_code from ops.checklist_template c join core.tenant t on t.id = c.tenant_id
      where t.code = $1 order by 1`,
    [code],
  );
  expect(lists.map((l) => l.library_code)).toEqual(
    expect.arrayContaining(['COUNTER-OPENING', 'DELIVERY-PACKING', 'CHILLER-LOG']),
  );
});

test('the templates page says what each kind of outlet starts with', async ({ page }) => {
  await signInPlatform(page);
  await page.goto('/platform');
  await page.getByRole('link', { name: /Outlet templates/ }).click();
  await expect(page.getByTestId('template-cafe')).toContainText('Barista');
  await expect(page.getByTestId('template-bar_pub')).toContainText('Bar Manager');
  await expect(page.getByTestId('template-hotel')).toContainText('Front Office');
});
