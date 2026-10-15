import { expect, test } from '@playwright/test';

// The landing and sign-in screen and the app's name and icons (ADR 161), at 380 px. The
// e2e server has no Cognito, so the form is replaced by "not set up"; the form's steps
// against Cognito are proved in lib/auth/sign-in.test.ts.

test.use({ viewport: { width: 380, height: 800 } });

test('the landing screen is Hey Senior, with Senior and its icons', async ({ page, request }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle('Hey Senior');
  await expect(page.getByText('Hey Senior', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'People come and go. Senior stays.',
  );
  // Senior's picture loads without a session
  const senior = page.getByTestId('senior');
  await expect(senior).toBeVisible();
  expect(await senior.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  for (const path of [
    '/icon.svg',
    '/senior.svg',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/maskable-512.png',
    '/icons/apple-180.png',
  ]) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
  const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
    name: string;
    short_name: string;
    theme_color: string;
  };
  expect(manifest).toMatchObject({
    name: 'Hey Senior',
    short_name: 'Hey Senior',
    theme_color: '#1f5f57',
  });
  // the old name is gone from the screen
  await expect(page.locator('body')).not.toContainText('Outlet Ops');
});
