import { expect, test } from '@playwright/test';
import { baseUrl, runPlatformWorker, signInAs, signInPlatform } from './helpers';

// The Platform Admin console (ADR 012) through its real screens, with a signed platform
// cookie (the platform pool is not configured in e2e).

test('platform and customer sessions never cross', async ({ page }) => {
  await signInAs(page, 'Test Account Owner');
  await page.goto('/platform');
  await expect(page).toHaveURL(/\/platform\/signin\?reason=invalid/);

  await signInPlatform(page);
  await page.goto('/platform');
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('create a customer: queued, created by the worker, owner invited', async ({ page }) => {
  const code = `E2E-${Date.now().toString(36).toUpperCase()}`;
  await signInPlatform(page);
  await page.goto('/platform');
  await page.getByRole('link', { name: 'New customer' }).click();
  const form = page.getByRole('form', { name: 'New customer' });
  await expect(form.getByRole('button', { name: 'Create customer' })).toBeEnabled();
  await form.getByLabel('Company name').fill(`E2E Hotels ${code}`);
  await form.getByLabel('Customer code').fill(code);
  await form.getByLabel('Owner name').fill('Asha Rao');
  // no silent default: the suggestion is a button, and the field starts empty
  await expect(form.getByLabel('Owner username', { exact: true })).toHaveValue('');
  await form.getByRole('button', { name: `Use suggested: ${code.toLowerCase()}.owner` }).click();
  await form.getByLabel('Owner email').fill(`${code.toLowerCase()}@example.test`);
  await form.getByRole('button', { name: 'Create customer' }).click();
  // the check before creating: the owner's username and sign-in type, large
  const check = page.getByRole('dialog', { name: 'Confirm the first account owner' });
  await expect(check.getByTestId('confirm-owner-username')).toHaveText(
    `${code.toLowerCase()}.owner`,
  );
  await expect(check.getByTestId('confirm-owner-login')).toHaveText(
    `Email login: invitation to ${code.toLowerCase()}@example.test`,
  );
  await check.getByRole('button', { name: 'Confirm and create' }).click();
  await page.waitForURL(/\/platform\/jobs\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('job-status')).toHaveText('queued');

  runPlatformWorker();
  await expect(page.getByTestId('job-status')).toHaveText('done'); // the page polls
  await page.getByRole('button', { name: "Send the owner's invitation" }).click();
  await expect(page.getByRole('status')).toHaveText(
    `Invitation sent to ${code.toLowerCase()}@example.test.`,
  );

  await page.goto('/platform');
  const row = page.locator(`[data-code="${code}"]`);
  await expect(row.getByTestId('customer-status')).toHaveText('active');
  await expect(row).toContainText('1 active people');
});

test('suspending a customer signs its people out; reactivating lets them back in', async ({
  page,
  browser,
}) => {
  const staff = await browser.newPage();
  await signInAs(staff, 'Test Head Bartender'); // Test Solo Bar Co.

  await signInPlatform(page);
  await page.goto('/platform');
  const solo = page.locator('[data-code="TEST-SOLO-COMPANY"]');
  await solo.getByLabel('Reason').fill('e2e: unpaid invoice');
  await solo.getByRole('button', { name: 'Suspend' }).click();
  await expect(solo.getByTestId('customer-status')).toHaveText('suspended');

  await staff.goto('/');
  await expect(staff).toHaveURL(/\/login\?reason=expired/);
  // other customers are untouched
  const other = await browser.newPage();
  await signInAs(other, 'Test Account Owner');

  await solo.getByLabel('Reason').fill('e2e: paid');
  await solo.getByRole('button', { name: 'Reactivate' }).click();
  await expect(solo.getByTestId('customer-status')).toHaveText('active');
  await signInAs(staff, 'Test Head Bartender');
  await staff.close();
  await other.close();
});

// The platform cookie is SameSite=Strict. Coming back from the Cognito hosted UI is a
// navigation started on another site (its sign-in form posts, then 302s to us), and a
// redirect keeps it cross-site all the way, so the browser withholds the cookie on every
// hop of it. The callback therefore ends at /platform/auth/continue, a page on our own
// site that moves on to /platform: that navigation starts here, so the cookie goes with
// it. The stand-in hosted UI below is another site whose form posts and 302s, as
// Cognito's does.
test('returning from the hosted UI (another site) lands signed in', async ({ page }) => {
  const hostedUi = 'https://auth.e2e.test';
  await page.route(`${hostedUi}/**`, (route) => {
    const url = new URL(route.request().url());
    const to = url.searchParams.get('to') ?? '/';
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 302,
        headers: { location: new URL(to, baseUrl()).toString() },
      });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: `<form method="post" action="${hostedUi}/login?to=${encodeURIComponent(to)}"><button>Sign in</button></form>`,
    });
  });
  const signInThere = async (to: string) => {
    await page.goto(`${hostedUi}/?to=${encodeURIComponent(to)}`);
    await page.getByRole('button', { name: 'Sign in' }).click();
  };

  await signInPlatform(page);
  // Straight to /platform from the other site: the Strict cookie is withheld (the bug).
  await signInThere('/platform');
  await expect(page).toHaveURL(/\/platform\/signin\?reason=invalid/);

  await signInPlatform(page);
  // Through the continue page: signed in.
  await signInThere('/platform/auth/continue');
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/platform');
});
