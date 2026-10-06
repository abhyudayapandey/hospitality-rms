import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

// Opening the app when the server can't be reached (ADR 063): within about 10 seconds the
// phone shows "Can't reach Outlet Ops" with Try again, instead of a blank screen, and the app
// comes back by itself once the connection does.

test.use({ viewport: { width: 380, height: 800 } });

test('no connection: the screen says so at once, and the app comes back by itself', async ({
  page,
  context,
}) => {
  await signInAs(page, 'Test Head Cook 3.0');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // now the service worker controls the page
  await context.setOffline(true);
  await page.goto('/tasks').catch(() => undefined);
  await expect(page.getByRole('heading', { name: "Can't reach Outlet Ops" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await context.setOffline(false);
  // it tries again by itself (on "online", and every 10 seconds)
  await expect(page.getByRole('heading', { name: "Can't reach Outlet Ops" })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page).toHaveURL(/\/tasks$/);
});

test('a server that does not answer: the screen comes within about 10 seconds', async ({
  page,
}) => {
  await signInAs(page, 'Test Head Cook 3.0');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  // the next page never answers
  await page.context().route('**/me', () => new Promise(() => {}));
  const started = Date.now();
  await page.goto('/me', { waitUntil: 'commit' }).catch(() => undefined);
  await expect(page.getByRole('heading', { name: "Can't reach Outlet Ops" })).toBeVisible({
    timeout: 15_000,
  });
  expect(Date.now() - started).toBeLessThan(14_000);
});
