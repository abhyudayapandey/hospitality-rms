import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

// Bottom nav follows core.my_domains(), and Menu and Production what there is to open;
// the pages themselves are enforced in the DB.
const cases: [string, string[], string[]][] = [
  ['Test Head Cook 3.0', ['Home', 'Inbox', 'Requests', 'Stock', 'Roster'], ['Admin']],
  ['Test HR Admin', ['Home', 'Inbox', 'Requests', 'Roster'], ['Stock', 'Admin']],
  ['Test Account Owner', ['Home', 'Inbox', 'Requests', 'Admin'], ['Stock']],
  ['Test Server 3.0', ['Home', 'Inbox', 'Requests', 'Roster'], ['Stock', 'Admin']],
  // records batches at the kitchen store only (PRODUCTION_TEAM, ADR 016)
  ['Test Commis 1.0', ['Home', 'Inbox', 'Requests', 'Production', 'Menu', 'Roster'], ['Stock']],
  // the main store makes and sells nothing: no Menu (audit #7)
  ['Test Store Keeper 1.0', ['Home', 'Inbox', 'Requests', 'Stock', 'Roster'], ['Menu', 'Admin']],
];

for (const [who, shown, hidden] of cases) {
  test(`nav for ${who}`, async ({ page }) => {
    await signInAs(page, who);
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const label of shown) await expect(nav.getByRole('link', { name: label })).toBeVisible();
    for (const label of hidden) await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
  });
}

test('admin screen refuses users without administration rights even by URL', async ({ page }) => {
  await signInAs(page, 'Test Head Cook 3.0');
  await page.goto('/admin');
  await expect(page.getByRole('main')).toContainText("You don't have access to administration.");
  await page.goto('/admin/users');
  await expect(page.getByRole('main')).toContainText("You don't have access to administration.");
  await signInAs(page, 'Test Auditor');
  await page.goto('/admin');
  await expect(page.getByTestId('assignments')).toContainText('Test Head Cook 3.0');
});
