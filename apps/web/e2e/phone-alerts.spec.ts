import { expect, test, type Page } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Alerts on this phone (ADR 137) at 380 px. A test browser cannot reach a real push service,
// so the browser's permission and push subscription are stood in for; what the app saves is
// real. Sending, and what a phone receives, is proved in packages/workflow/src/push.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const ENDPOINT = `https://fcm.googleapis.com/fcm/send/e2e-${Date.now()}`;

async function standInPush(page: Page) {
  await page.addInitScript((endpoint) => {
    const w = window as unknown as { __perm?: NotificationPermission };
    Object.defineProperty(Notification, 'permission', { get: () => w.__perm ?? 'default' });
    Notification.requestPermission = () => Promise.resolve((w.__perm = 'granted'));
    const sub = {
      endpoint,
      toJSON: () => ({ endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }),
      unsubscribe: () => {
        localStorage.removeItem('e2e.sub');
        return Promise.resolve(true);
      },
    };
    PushManager.prototype.getSubscription = () =>
      Promise.resolve(
        (localStorage.getItem('e2e.sub') ? sub : null) as unknown as PushSubscription,
      );
    PushManager.prototype.subscribe = () => {
      localStorage.setItem('e2e.sub', '1');
      return Promise.resolve(sub as unknown as PushSubscription);
    };
  }, ENDPOINT);
}

const saved = async () =>
  (
    await asMigrator<{ on: boolean }>(
      `select archived_at is null as on from ops.push_subscription where endpoint = $1`,
      [ENDPOINT],
    )
  ).map((r) => r.on);

test('Home asks once; Profile turns alerts on and off for this phone', async ({ page }) => {
  try {
    await standInPush(page);
    await signInAs(page, 'Test Steward 1.0');
    await page.goto('/');
    const card = page.getByTestId('alerts-card');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Not now' }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(card).toHaveCount(0);

    // Profile: on, saved for this person; then off
    await page.goto('/profile');
    const row = page.getByTestId('alerts-row');
    await expect(row).toHaveAttribute('data-state', 'off');
    await row.getByRole('button', { name: 'Turn on alerts' }).click();
    await expect(row).toHaveAttribute('data-state', 'on');
    await expect(row).toContainText('Alerts are on for this phone.');
    await expect.poll(saved).toEqual([true]);
    await row.getByRole('button', { name: 'Turn off alerts' }).click();
    await expect(row).toHaveAttribute('data-state', 'off');
    await expect.poll(saved).toEqual([false]);

    // Home's Turn on does the same in one tap
    await page.evaluate(() => localStorage.removeItem('oo.alerts.asked'));
    await page.goto('/');
    await card.getByRole('button', { name: 'Turn on' }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await saved()).includes(true)).toBe(true);
  } finally {
    await asMigrator(`delete from ops.push_subscription where endpoint = $1`, [ENDPOINT]);
  }
});
