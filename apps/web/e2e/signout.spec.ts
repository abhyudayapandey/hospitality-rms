import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

test('sign-out clears the session and refresh cookies and the service-worker caches', async ({
  page,
  context,
}) => {
  await signInAs(page, 'Test Head Cook 3.0');
  // The service worker precaches the offline page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(async () => (await caches.keys()).length), { timeout: 15_000 })
    .toBeGreaterThan(0);
  // Pretend a Cognito refresh cookie exists too.
  await context.addCookies([{ name: 'oo_refresh', value: 'x', url: page.url() }]);

  // Sign out is on Me (UX-6)
  await page.goto('/me');
  // the server is slow to answer: the screen is covered at once all the same (ADR 056)
  await page.route('**/auth/logout', async (route) => {
    await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('leaving')).toContainText('Signing you out');
  await page.waitForURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Outlet Ops', level: 1 })).toBeVisible();
  // the app's screen was replaced: Back does not return to it
  await page.goBack().catch(() => undefined);
  await expect(page).not.toHaveURL(/\/me$/);

  expect(await page.evaluate(async () => caches.keys())).toEqual([]);
  const names = (await context.cookies()).map((c) => c.name);
  expect(names).not.toContain('oo_session');
  expect(names).not.toContain('oo_refresh');

  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/login/);
});
