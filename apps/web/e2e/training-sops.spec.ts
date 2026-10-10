import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Training & SOPs (ADR 095) at 380 px on Test Hotel 1.0's kitchen: the commis reads the
// handwashing SOP and confirms it; the executive chef sees who has read it, adds a test session
// and marks the commis there with a score. Who may is proved in training-sops.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('an SOP is read and confirmed; a session is kept with its score', async ({ page }) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN');
  const title = `Allergen test ${Date.now()}`;
  try {
    await signInAs(page, 'Test Commis 1.0');
    await page.goto('/me/sops');
    const hand = main(page).getByTestId('my-sop').filter({ hasText: 'Handwashing' });
    await expect(hand.getByTestId('sop-ack')).toHaveText('To read');
    await hand.click();
    await expect(main(page).getByTestId('sop-body')).toContainText('20 seconds');
    await main(page).getByRole('button', { name: "I've read this" }).click();
    await expect(main(page).getByTestId('sop-acked')).toBeVisible();

    await signInAs(page, 'Test Executive Chef 1.0');
    await page.goto(`/training?place=${kitchen}&view=sops`);
    await expect(
      main(page).getByTestId('sop-read').filter({ hasText: 'Handwashing' }),
    ).not.toContainText('Test Commis 1.0,');
    await page.goto(`/training?place=${kitchen}`);
    await main(page).getByLabel('What').fill(title);
    await main(page).getByLabel('When').fill('2026-10-10T15:00');
    await main(page).getByLabel('It has a test with a score').check();
    await main(page).getByRole('button', { name: 'Add the session' }).click();
    await page.waitForURL(/\/training\/[0-9a-f-]{36}/);
    const row = main(page).getByTestId('attendance').filter({ hasText: 'Test Commis 1.0' });
    await row.getByLabel('Test Commis 1.0 came').check();
    await row.getByLabel('Test Commis 1.0 score').fill('85');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(row.getByRole('button', { name: 'Saved · change' })).toBeVisible();
  } finally {
    await asMigrator(
      `delete from ops.training_attendance where session_id in
         (select id from ops.training_session where title = $1)`,
      [title],
    );
    await asMigrator(`delete from ops.training_session where title = $1`, [title]);
    await asMigrator(
      `delete from ops.sop_ack where sop_id in (select id from ops.sop where code = 'HOTEL-1.0-HANDWASH')`,
      [],
    );
  }
});
