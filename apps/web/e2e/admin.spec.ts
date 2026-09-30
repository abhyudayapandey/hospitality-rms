import { expect, test } from '@playwright/test';
import { placeId, signInAs } from './helpers';

// User administration through the real screens (ADR 011). Without Cognito configured the
// no-op login directory stands in, so the database side is what these check.

const GM1 = 'Test General Manager 1.0'; // User Admin for Hotel 1.0

test('add a person: preview the access, save, get a temporary password once', async ({ page }) => {
  const stamp = Date.now().toString(36);
  await signInAs(page, GM1);
  await page.goto('/admin');
  await page.getByRole('link', { name: /People/ }).click();
  await page.getByRole('link', { name: 'Add a person' }).click();

  const form = page.getByRole('form', { name: 'Add a person' });
  await expect(form.getByRole('button', { name: 'Preview access' })).toBeEnabled(); // hydrated
  await form.getByLabel('Name', { exact: true }).fill(`E2E Commis ${stamp}`);
  await form.getByLabel('Name', { exact: true }).blur();
  await form.getByLabel('Job role').selectOption({ label: 'Commis' });
  await form.getByLabel('Home place').selectOption(await placeId('TEST-HOTEL-1.0-KITCHEN'));
  // the suggestion starts with the customer code
  await expect(form.getByLabel('Username', { exact: true })).toHaveValue(/^test-company\.e2e\./);
  await form.getByLabel('Username', { exact: true }).fill(`test-company.e2e.${stamp}`);
  await form.getByRole('button', { name: 'Preview access' }).click();

  const preview = page.getByTestId('preview');
  await expect(preview.locator('li').first()).toBeVisible();
  await expect(preview.getByTestId('applies').first()).toHaveText('Applies now');
  await form.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByTestId('created')).toContainText(`test-company.e2e.${stamp}`);
  await expect(page.getByTestId('temporary-password')).toHaveText(/^[A-Za-z2-9]{14}$/);
  await page.getByRole('link', { name: `Open E2E Commis ${stamp}` }).click();
  await expect(page.getByTestId('person-access')).toContainText('STAFF');
});

test('a sensitive grant says it needs approval before saving', async ({ page }) => {
  await signInAs(page, GM1);
  await page.goto('/admin/users?q=bellboy');
  await page
    .getByTestId('people')
    .getByRole('link', { name: /Test Bellboy 1.0/ })
    .click();
  const add = page.getByRole('form', { name: 'Add access' });
  await add.getByLabel('Place').selectOption(await placeId('TEST-HOTEL-1.0'));
  await add.getByLabel('Access').selectOption({ label: 'Outlet Manager' });
  await expect(add.getByTestId('applies')).toHaveText('Needs approval (ROLE_CHANGE)');
  await add.getByLabel('Access').selectOption({ label: 'Stock User' });
  await expect(add.getByTestId('applies')).toHaveText('Applies now');
});

test('deactivating signs the person out; reactivating lets them back in', async ({
  page,
  browser,
}) => {
  const other = await browser.newPage();
  await signInAs(other, 'Test Bell Captain 1.0');

  await signInAs(page, GM1);
  await page.goto('/admin/users?q=bell captain');
  await page
    .getByTestId('people')
    .getByRole('link', { name: /Test Bell Captain 1.0/ })
    .click();
  await page.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('status')).toContainText('Deactivated');
  await expect(page.getByTestId('person-status')).toHaveText('inactive');

  // their session ends on the next request
  await other.goto('/');
  await expect(other).toHaveURL(/\/login\?reason=expired/);

  await page.getByRole('button', { name: 'Reactivate' }).click();
  await expect(page.getByTestId('person-status')).toHaveText('active');
  await signInAs(other, 'Test Bell Captain 1.0');
  await other.close();
});

test('an admin action from another origin is refused', async ({ page }) => {
  await signInAs(page, GM1);
  await page.goto('/admin/users?q=laundry');
  await page
    .getByTestId('people')
    .getByRole('link', { name: /Test Laundry Attendant 1.0/ })
    .click();
  const url = page.url();
  // capture the real server-action POST behind "Deactivate" and stop it...
  let captured: { headers: Record<string, string>; body: string } | undefined;
  await page.route('**/admin/users/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    captured = { headers: req.headers(), body: req.postData() ?? '' };
    await route.abort();
  });
  await page.getByRole('button', { name: 'Deactivate' }).click();
  await expect.poll(() => captured !== undefined).toBe(true);
  await page.unroute('**/admin/users/**');
  // ...then replay it as a forged cross-site request with the same session cookie
  const res = await page.request.post(url, {
    headers: {
      ...captured!.headers,
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    },
    data: captured!.body,
  });
  expect(await res.text()).not.toContain('"ok":true');
  await page.reload();
  await expect(page.getByTestId('person-status')).toHaveText('active');
});
