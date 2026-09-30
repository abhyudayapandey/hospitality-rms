import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

// Bottom nav follows core.my_domains(); the pages themselves are enforced in the DB.
const cases: [string, string[], string[]][] = [
  ['Kim Storekeeper', ['Home', 'Inbox', 'Requests', 'Stock', 'Roster'], ['Admin']],
  ['Harper HR Admin', ['Home', 'Inbox', 'Requests', 'Roster'], ['Stock', 'Admin']],
  ['Owen Account Owner', ['Home', 'Inbox', 'Requests', 'Admin'], ['Stock']],
  ['Sam Staff', ['Home', 'Inbox', 'Requests', 'Roster'], ['Stock', 'Admin']],
];

for (const [who, shown, hidden] of cases) {
  test(`nav for ${who}`, async ({ page }) => {
    await signInAs(page, who);
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const label of shown) await expect(nav.getByRole('link', { name: label })).toBeVisible();
    for (const label of hidden) await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
  });
}

test('admin screen refuses users without SECURITY_ROLES even by URL', async ({ page }) => {
  await signInAs(page, 'Kim Storekeeper');
  await page.goto('/admin');
  // Scoped to <main>: Next's route announcer is also role=alert.
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    "You don't have access to do that.",
  );
  await signInAs(page, 'Avery Auditor');
  await page.goto('/admin');
  await expect(page.getByTestId('assignments')).toContainText('Kim Storekeeper');
});

test('node switcher lists the user nodes and switches', async ({ page }) => {
  await signInAs(page, 'Aria Area Manager');
  const sw = page.getByRole('combobox', { name: 'Location' });
  await expect(sw.locator('option')).toHaveText([
    'Area · People',
    'Outlet A · People',
    'Outlet B · People',
    'Outlet A · Supply (view)',
    'Outlet B · Supply (view)',
  ]);
  await sw.selectOption({ label: 'Outlet B · People' });
  await expect(page.getByText('Working at')).toContainText('Outlet B');
});
