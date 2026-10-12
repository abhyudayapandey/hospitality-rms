import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Floor sections (ADR 133) at 380 px on Test Hotel 1.0's restaurant (file 47: Section 1 to 3):
// its manager gives Section 2 to a steward from Home, and the steward sees it on Home. Who may
// give sections is proved in packages/db/src/sections.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('the restaurant manager gives Section 2; the steward sees it on Home', async ({ page }) => {
  const dept = await placeId('TEST-HOTEL-1.0-RESTAURANT');
  try {
    await signInAs(page, 'Test Restaurant Manager 1.0');
    await page.goto('/');
    await main(page).getByTestId('home-give-sections').click();
    await page.waitForURL(/\/sections\/give/);
    await main(page)
      .getByRole('group', { name: 'Person' })
      .getByRole('button', { name: /Test Steward 1\.0/ })
      .click();
    await main(page).getByRole('button', { name: 'Section 2', exact: true }).click();
    await main(page)
      .getByRole('button', { name: /^Give .* 1 section$/ })
      .click();
    await expect(main(page).getByRole('status')).toContainText('Section 2');

    await signInAs(page, 'Test Steward 1.0');
    await page.goto('/');
    const card = main(page).getByTestId('home-sections');
    await expect(card).toContainText('Your section today');
    await expect(card).toContainText('Section 2');
    // a steward does not give sections
    await expect(card.getByTestId('home-give-sections')).toHaveCount(0);
  } finally {
    await asMigrator(`delete from ops.section_assignment where org_node_id = $1`, [dept]);
  }
});
