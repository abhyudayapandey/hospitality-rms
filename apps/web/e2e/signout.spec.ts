import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

test('sign-out clears the session and refresh cookies and the service-worker caches', async ({
  page,
  context,
}) => {
  await signInAs(page, 'Kim Storekeeper');
  // The service worker precaches the offline page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(async () => (await caches.keys()).length), { timeout: 15_000 })
    .toBeGreaterThan(0);
  // Pretend a Cognito refresh cookie exists too.
  await context.addCookies([{ name: 'oo_refresh', value: 'x', url: page.url() }]);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);

  expect(await page.evaluate(async () => caches.keys())).toEqual([]);
  const names = (await context.cookies()).map((c) => c.name);
  expect(names).not.toContain('oo_session');
  expect(names).not.toContain('oo_refresh');

  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/login/);
});
