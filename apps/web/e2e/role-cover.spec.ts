import { expect, test } from '@playwright/test';
import { placeId, signInAs, storeKeeperCover } from './helpers';

// Who covers it (ADR 061) through the real screens, at 380 px: Guest House 2.0 has no Store
// Keeper, so its Front Desk covers one (the seed's file 37, ADR 066). They see the Store
// Keeper's task, saying whose work it is, and the outlet's stock; with the cover gone, neither.
// Who may do what is proved in packages/db/src/role-cover.db.test.ts.

test.use({ viewport: { width: 380, height: 800 } });
test.afterEach(() => storeKeeperCover(true, false)); // the seed's state

test('the front desk covering the store keeper gets the store keeper’s task and stock', async ({
  page,
}) => {
  const store = await placeId('TEST-GUEST-HOUSE-2.0-SUPPLY');
  await storeKeeperCover(true);
  await signInAs(page, 'Test Front Desk Executive 2.0');
  await page.goto('/tasks');
  const row = page.getByRole('link', { name: /E2E covered count/ });
  await expect(row.getByTestId('task-covering')).toHaveText(
    'Store Keeper’s work (you’re covering)',
  );
  await page.goto(`/stock?node=${store}`);
  const jobs = page.getByRole('navigation', { name: 'Stock jobs' }).getByRole('link');
  await expect(jobs.first()).toHaveText('Count');

  await storeKeeperCover(false);
  await signInAs(page, 'Test Front Desk Executive 2.0');
  await page.goto('/tasks');
  await expect(page.getByRole('link', { name: /E2E covered count/ })).toHaveCount(0);
  await page.goto(`/stock?node=${store}`);
  await expect(page.getByRole('navigation', { name: 'Stock jobs' })).toHaveCount(0);
});
