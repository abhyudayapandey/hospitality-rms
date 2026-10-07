import { expect, test } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Show as someone else, for demos (ADR 071) at 380 px. Test Company's account owner is made
// a demo presenter for this test only: from Me they show the app as the Bar Manager of
// Bar 3.0, whose Home and name they then see with a banner; Back to them ends it. Someone who
// isn't a presenter is told so. Who may, and what the database refuses meanwhile, is proved
// in packages/db/src/show-as.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

test('a demo presenter shows the app as the bar manager, then comes back', async ({ page }) => {
  await asMigrator(
    `update core.app_user set demo_presenter = true where username = 'test.account-owner'`,
    [],
  );
  try {
    await signInAs(page, 'Test Account Owner');
    await page.goto('/me');
    await page.getByTestId('me-show-as').click();
    await page.waitForURL(/\/show-as$/);
    await page.getByLabel('Find a person').fill('Bar Manager 3.0');
    await page.getByTestId('show-as-person').filter({ hasText: 'Test Bar Manager 3.0' }).click();

    await page.waitForURL((u) => u.pathname === '/');
    await expect(page.getByTestId('current-user')).toHaveText('Test Bar Manager 3.0');
    // their job title beside their name
    await expect(page.getByTestId('current-role')).toHaveText('Bar Manager');
    const banner = page.getByTestId('show-as-banner');
    await expect(banner).toContainText('Showing as Test Bar Manager 3.0');
    // every screen is theirs: their stock, not the owner's company-wide view
    await page.goto('/stock');
    await expect(page.getByTestId('show-as-banner')).toBeVisible();
    await expect(page.getByTestId('current-user')).toHaveText('Test Bar Manager 3.0');

    await page.getByTestId('show-as-banner').getByRole('button', { name: 'Back to Test' }).click();
    await page.waitForURL((u) => u.pathname === '/');
    await expect(page.getByTestId('current-user')).toHaveText('Test Account Owner');
    await expect(page.getByTestId('show-as-banner')).toHaveCount(0);

    // someone who isn't a presenter
    await signInAs(page, 'Test General Manager 1.0');
    await page.goto('/me');
    await expect(page.getByTestId('me-show-as')).toHaveCount(0);
    await page.goto('/show-as');
    await expect(
      page.getByText('Only a demo presenter of a test company can show the app as someone else.'),
    ).toBeVisible();
  } finally {
    await asMigrator(`update core.show_as_log set ended_at = now() where ended_at is null`, []);
    await asMigrator(
      `update core.app_user set demo_presenter = false where username = 'test.account-owner'`,
      [],
    );
  }
});
