import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

// A tap answers at once, however slow the server (ADR 055).

test('a slow screen shows its skeleton and the top bar at once; a second tap is ignored', async ({
  page,
}) => {
  await signInAs(page, 'Test Store Keeper 1.0', { expanded: false });
  await page.goto('/stock');
  // the server takes 2 s to build Tasks, as on a phone network
  let calls = 0;
  await page.route(/\/tasks(\?|$)/, async (route) => {
    calls++;
    await new Promise((r) => setTimeout(r, 2_000));
    await route.continue();
  });
  const tasks = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks' });
  await tasks.click();
  await expect(page.getByTestId('page-loading')).toBeVisible();
  await expect(page.locator('.nav-progress').first()).toBeVisible();
  const before = calls;
  await tasks.click();
  await page.waitForTimeout(300);
  expect(calls).toBe(before);
  await page.waitForURL(/\/tasks/);
  await expect(page.getByTestId('page-loading')).toHaveCount(0);
  await expect(page.locator('.nav-progress')).toHaveCount(0);
});

test('after a deploy, an open app offers to reload', async ({ page }) => {
  await signInAs(page, 'Test Store Keeper 1.0', { expanded: false });
  // the same build: nothing to say
  const mine = (await (await page.request.get('/api/version')).json()) as { build: string };
  expect(mine.build).not.toBe('');
  await page.goto('/stock');
  await expect(page.getByTestId('new-version')).toHaveCount(0);
  // the server now runs another build; the app notices when it comes back to the screen
  await page.route('/api/version', (route) =>
    route.fulfill({ json: { build: `${mine.build}-next` } }),
  );
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const bar = page.getByTestId('new-version');
  await expect(bar).toContainText('A new version of the app is ready.');
  await page.unroute('/api/version');
  await bar.getByRole('button', { name: 'Reload' }).click();
  await page.waitForLoadState('load');
  await expect(page.getByTestId('new-version')).toHaveCount(0);
});
