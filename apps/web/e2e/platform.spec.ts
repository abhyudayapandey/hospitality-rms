import { expect, test } from '@playwright/test';
import { baseUrl, runPlatformWorker, signInAs, signInPlatform } from './helpers';

// The team console (ADR 012, 075) through its real screens, with a signed platform
// cookie (the platform pool is not configured in e2e).

test('platform and customer sessions never cross', async ({ page }) => {
  await signInAs(page, 'Test Account Owner');
  await page.goto('/platform');
  await expect(page).toHaveURL(/\/platform\/signin\?reason=invalid/);

  await signInPlatform(page);
  await page.goto('/platform');
  await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('create a customer: queued, created by the worker, owner invited', async ({ page }) => {
  const code = `E2E-${Date.now().toString(36).toUpperCase()}`;
  await signInPlatform(page);
  await page.goto('/platform');
  await page.getByRole('link', { name: /Add a customer from their files/ }).click();
  const form = page.getByRole('form', { name: 'New customer' });
  await expect(form.getByRole('button', { name: 'Create the customer' })).toBeEnabled();
  await form.getByLabel('Company name').fill(`E2E Hotels ${code}`);
  await form.getByLabel('Their code').fill(code);
  await form.getByLabel('Owner name').fill('Asha Rao');
  // no silent default: the suggestion is a button, and the field starts empty
  await expect(form.getByLabel("Owner's login ID")).toHaveValue('');
  await form.getByRole('button', { name: `Use suggested: ${code.toLowerCase()}.owner` }).click();
  await form.getByLabel('Owner email').fill(`${code.toLowerCase()}@example.test`);
  await form.getByRole('button', { name: 'Create the customer' }).click();
  // the check before creating: the owner's username and sign-in type, large
  const check = page.getByRole('dialog', { name: 'Confirm the first account owner' });
  await expect(check.getByTestId('confirm-owner-username')).toHaveText(
    `${code.toLowerCase()}.owner`,
  );
  await expect(check.getByTestId('confirm-owner-login')).toHaveText(
    `Signs in with email: an invitation goes to ${code.toLowerCase()}@example.test`,
  );
  await check.getByRole('button', { name: 'Confirm and create' }).click();
  await page.waitForURL(/\/platform\/jobs\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('job-status')).toHaveText('Waiting to start');

  runPlatformWorker();
  await expect(page.getByTestId('job-status')).toHaveText('Finished'); // the page polls
  await page.getByRole('button', { name: "Send the owner's invitation" }).click();
  await expect(page.getByRole('status')).toHaveText(
    `Invitation sent to ${code.toLowerCase()}@example.test.`,
  );

  await page.goto('/platform');
  const row = page.locator(`[data-code="${code}"]`);
  await expect(row.getByTestId('customer-status')).toHaveText('Active');
  await expect(row).toContainText('1 person · nobody has signed in yet');
});

test('pausing a customer signs its people out; resuming lets them back in', async ({
  page,
  browser,
}) => {
  const staff = await browser.newPage();
  await signInAs(staff, 'Test Head Bartender'); // Test Solo Bar Co.

  await signInPlatform(page);
  await page.goto('/platform');
  const solo = page.locator('[data-code="TEST-SOLO-COMPANY"]');
  // pausing is not on the list: it is on the customer's page, behind a tap
  await expect(solo.getByRole('button')).toHaveCount(0);
  await solo.getByRole('link').click();
  await page.waitForURL(/\/platform\/customers\//);
  await page.getByText('Pause this customer').click();
  const pause = page.getByRole('form', { name: 'Pause Test Solo Bar Co.' });
  await pause.getByLabel('Why').fill('e2e: unpaid invoice');
  await pause.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByTestId('customer-line')).toContainText('Paused');

  await staff.goto('/');
  await expect(staff).toHaveURL(/\/login\?reason=expired/);
  // other customers are untouched
  const other = await browser.newPage();
  await signInAs(other, 'Test Account Owner');

  await page.getByText('Resume this customer').click();
  const resume = page.getByRole('form', { name: 'Resume Test Solo Bar Co.' });
  await resume.getByLabel('Why').fill('e2e: paid');
  await resume.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByTestId('customer-line')).toContainText('Active');
  await signInAs(staff, 'Test Head Bartender');
  await staff.close();
  await other.close();
});

test('the customers page at 380 px: one main action, the list, then the other tools apart', async ({
  page,
}) => {
  await page.setViewportSize({ width: 380, height: 900 });
  await signInPlatform(page);
  await page.goto('/platform');
  await expect(page.getByText('Customers never see this')).toBeVisible();
  const main = page.getByRole('button', { name: 'Set up a new customer' });
  const list = page.getByTestId('customers');
  const tools = page.getByRole('region', { name: 'Other tools' });
  // each tool its own row, never run together on one line
  const kinds = tools.getByRole('link', { name: /Kinds of outlet/ });
  const files = tools.getByRole('link', { name: /Add a customer from their files/ });
  await expect(kinds).toBeVisible();
  await expect(files).toBeVisible();
  const y = async (l: typeof main) => (await l.boundingBox())!.y;
  expect(await y(main)).toBeLessThan(await y(list));
  expect(await y(list)).toBeLessThan(await y(kinds));
  expect((await y(kinds)) + (await kinds.boundingBox())!.height).toBeLessThanOrEqual(
    await y(files),
  );
  // names and words, no codes or raw states
  await expect(list).not.toContainText('TEST-COMPANY');
  await expect(list).not.toContainText('active');
  await expect(
    list.locator('[data-code="TEST-COMPANY"]').getByTestId('customer-status'),
  ).toHaveText('Active');
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
  await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/platform');
});
