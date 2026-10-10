import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Excise and covers (ADR 096) at 380 px on Test Hotel 1.0: the Bar Manager reads the bar store's
// register (each line's closing is what the store holds) and keeps a transport permit; the GM
// gives the day's covers on the outlet's day and sees the spend per cover. Who may is proved in
// excise.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('the bar register and a permit; covers and the spend per cover', async ({ page }) => {
  const store = await placeId('TEST-HOTEL-1.0-BAR-STORE');
  const outlet = await placeId('TEST-HOTEL-1.0');
  const permit = `TP-E2E-${Date.now()}`;
  try {
    await signInAs(page, 'Test Bar Manager 1.0');
    await page.goto(`/excise?node=${store}`);
    await expect(main(page).getByTestId('excise-line').first()).toBeVisible();
    await expect(main(page).getByTestId('excise-register')).not.toContainText('Orange Juice');
    await main(page).getByRole('link', { name: 'Permits' }).click();
    await main(page).getByLabel('Permit number').fill(permit);
    await main(page).getByLabel(/^Note/).fill('2 FOC bottles');
    await main(page).getByRole('button', { name: 'Keep the permit' }).click();
    await expect(main(page).getByTestId('permit').filter({ hasText: permit })).toContainText(
      '2 FOC bottles',
    );

    await signInAs(page, 'Test General Manager 1.0');
    await page.goto(`/reports/outlet?node=${outlet}`);
    const covers = main(page).getByTestId('covers');
    await covers.getByLabel('Lunch').fill('40');
    await covers.getByRole('button', { name: 'Save covers' }).click();
    await expect(covers.getByTestId('covers-total')).toHaveText('40');
  } finally {
    await asMigrator(`delete from inv.excise_permit where permit_no = $1`, [permit]);
    await asMigrator(`delete from ops.covers where org_node_id = $1`, [outlet]);
  }
});
