import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { readCustomerDir } from '@outlet-ops/onboarding';
import { zipFiles } from '@outlet-ops/onboarding/upload';
import { asMigrator, runPlatformWorker, signInPlatform } from './helpers';

// Imports and logins in the Platform Admin console (ADR 013), through the real screens and
// the real worker (platform_loader), with a signed platform cookie.

const testData = (dir: string) =>
  readCustomerDir(new URL(`../../../docs/onboarding/test-data/${dir}`, import.meta.url).pathname);

const tenantId = async (code: string) =>
  (await asMigrator<{ id: string }>('select id from core.tenant where code = $1', [code]))[0]!.id;

async function workerFinishes(page: Page, status: 'done' | 'failed' = 'done') {
  await expect(page.getByTestId('job-status')).toHaveText('queued');
  runPlatformWorker();
  await expect(page.getByTestId('job-status')).toHaveText(status); // the page polls
}

const ORIGINAL = 'fresh-produce@test-supplier.example';
const CHANGED = 'orders@fresh-produce.example';

test('import the test company zip: dry run, apply, apply again (no changes)', async ({ page }) => {
  const company = testData('test-company');
  const files = {
    ...company,
    '09_suppliers.csv': company['09_suppliers.csv']!.replace(ORIGINAL, CHANGED),
  };
  try {
    await signInPlatform(page);
    await page.goto('/platform');
    await page.locator('[data-code="TEST-COMPANY"]').getByRole('link').first().click();
    await page.getByRole('link', { name: 'Import setup files' }).click();
    await page.getByLabel('Files', { exact: true }).setInputFiles({
      name: 'test-company.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipFiles(files, 'test-company')),
    });
    await page.getByRole('button', { name: 'Upload and dry run' }).click();
    await page.waitForURL(/\/platform\/jobs\/[0-9a-f-]{36}$/);
    const dryRun = page.url();
    await workerFinishes(page);
    await expect(page.getByTestId('import-summary')).toHaveText(
      'Dry run: applying would make 1 change.',
    );
    // suppliers: 0 new, 1 changed
    const suppliers = page.locator('[data-table="suppliers"] td');
    await expect(suppliers.nth(1)).toHaveText('0');
    await expect(suppliers.nth(2)).toHaveText('1');

    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForURL((u) => u.href !== dryRun && /\/platform\/jobs\//.test(u.pathname));
    await workerFinishes(page);
    await expect(page.getByTestId('import-summary')).toHaveText('Applied: 1 change.');
    const [supplier] = await asMigrator<{ contact: string }>(
      `select contact from inv.supplier where code = 'SUPPLIER-FRESH-PRODUCE' and tenant_id = $1`,
      [await tenantId('TEST-COMPANY')],
    );
    expect(supplier!.contact).toBe(CHANGED);

    // apply the same dry run again: nothing left to change
    await page.getByRole('link', { name: 'The dry run this applied' }).click();
    await page.waitForURL(dryRun);
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForURL((u) => u.href !== dryRun && /\/platform\/jobs\//.test(u.pathname));
    await workerFinishes(page);
    await expect(page.getByTestId('import-summary')).toHaveText(
      'Applied. No changes: everything in these files was already loaded.',
    );
  } finally {
    await asMigrator(
      `update inv.supplier set contact = $1 where code = 'SUPPLIER-FRESH-PRODUCE' and contact = $2`,
      [ORIGINAL, CHANGED],
    );
  }
});

test('an upload for another customer is refused before anything is queued', async ({ page }) => {
  await signInPlatform(page);
  await page.goto(`/platform/customers/${await tenantId('TEST-SOLO-COMPANY')}/import`);
  await page.getByLabel('Files', { exact: true }).setInputFiles({
    name: 'test-company.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zipFiles(testData('test-company'))),
  });
  await page.getByRole('button', { name: 'Upload and dry run' }).click();
  await expect(page).toHaveURL(/\/import\?error=CUSTOMER_MISMATCH$/);
  await expect(page.locator('main').getByRole('alert')).toHaveText(
    'These files are for a different customer (file 00 names another code).',
  );
});

test('logins for a test customer with the Test<Role>!12 rule', async ({ page }) => {
  const solo = await tenantId('TEST-SOLO-COMPANY');
  const reset = () =>
    asMigrator(
      `update core.app_user set cognito_sub = null
        where tenant_id = $1 and (cognito_sub is null or cognito_sub like 'local:%')`,
      [solo],
    );
  await reset();
  try {
    await signInPlatform(page);
    await page.goto(`/platform/customers/${solo}/logins`);
    await expect(page.getByTestId('username-summary')).toContainText('0 of 7 have a login');
    await expect(page.getByText(/about 50 messages a day/)).toBeVisible();
    const form = page.getByRole('form', { name: 'Create username logins' });
    await expect(form.getByRole('button', { name: 'Create 7 username logins' })).toBeEnabled();
    await form.getByRole('checkbox').check();
    await form.getByRole('button', { name: 'Create 7 username logins' }).click();

    const created = page.getByTestId('created-logins');
    await expect(created).toContainText('7 logins created');
    await expect(
      created.locator('[data-username="test.solo.bar-manager"]').getByTestId('password'),
    ).toHaveText('TestBarManager!12');

    const download = page.waitForEvent('download');
    await created.getByRole('button', { name: 'Download as CSV (once)' }).click();
    const csv = readFileSync(await (await download).path(), 'utf8');
    expect(csv).toContain('test.solo.bar-manager,Test Bar Manager,TestBarManager!12,no');
    await expect(created.getByRole('button', { name: 'Downloaded' })).toBeDisabled();

    // passwords are never shown again
    await page.reload();
    await expect(page.getByTestId('username-summary')).toContainText('7 of 7 have a login');
    await expect(page.getByTestId('created-logins')).toHaveCount(0);
    await expect(page.getByTestId('password')).toHaveCount(0);
  } finally {
    await reset();
  }
});

test('the Test<Role>!12 option is refused for a customer that is not a test customer', async ({
  page,
}) => {
  const code = `E2E-NT-${Date.now().toString(36).toUpperCase()}`;
  const [t] = await asMigrator<{ id: string }>(
    `insert into core.tenant (name, code, is_test) values ($1, $2, false) returning id`,
    [`Not a Test ${code}`, code],
  );
  const username = `${code.toLowerCase()}.ravi.k`;
  await asMigrator(
    `insert into core.app_user (tenant_id, kind, display_name, username, login_type)
     values ($1, 'human', 'Ravi K', $2, 'username')`,
    [t!.id, username],
  );
  await signInPlatform(page);
  await page.goto(`/platform/customers/${t!.id}/logins`);
  const form = page.getByRole('form', { name: 'Create username logins' });
  // the screen does not offer it...
  await expect(form.getByRole('checkbox')).toBeDisabled();
  await expect(form).toContainText('Only for test customers; this one isn’t.');

  // ...and a tampered request asking for it anyway is refused by the server
  await page.route(`**/platform/customers/${t!.id}/logins`, async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.headers()['next-action']) {
      const body = req.postData() ?? '';
      expect(body).toContain(`"${t!.id}",false`);
      await route.continue({ postData: body.replace(`"${t!.id}",false`, `"${t!.id}",true`) });
    } else {
      await route.continue();
    }
  });
  await form.getByRole('button', { name: 'Create 1 username login' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'The Test<Role>!12 password rule is only for test customers.',
  );
  const [user] = await asMigrator<{ cognito_sub: string | null }>(
    'select cognito_sub from core.app_user where username = $1',
    [username],
  );
  expect(user!.cognito_sub).toBeNull();
});
