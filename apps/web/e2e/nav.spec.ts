import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

// Bottom nav follows core.my_domains(); the pages themselves are enforced in the DB.
const cases: [string, string[], string[]][] = [
  ['Test Head Cook 3.0', ['Home', 'Inbox', 'Requests', 'Stock', 'Roster'], ['Admin']],
  ['Test HR Admin', ['Home', 'Inbox', 'Requests', 'Roster'], ['Stock', 'Admin']],
  ['Test Account Owner', ['Home', 'Inbox', 'Requests', 'Admin'], ['Stock']],
  ['Test Server 3.0', ['Home', 'Inbox', 'Requests', 'Roster'], ['Stock', 'Admin']],
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
  await signInAs(page, 'Test Head Cook 3.0');
  await page.goto('/admin');
  // Scoped to <main>: Next's route announcer is also role=alert.
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    "You don't have access to do that.",
  );
  await signInAs(page, 'Test Auditor');
  await page.goto('/admin');
  await expect(page.getByTestId('assignments')).toContainText('Test Head Cook 3.0');
});

test('node switcher lists the user nodes and switches', async ({ page }) => {
  await signInAs(page, 'Test Area Manager');
  const sw = page.getByRole('combobox', { name: 'Location' });
  const labels = await sw.locator('option').allTextContents();
  expect(labels[0]).toBe('Test Area Mumbai · People');
  expect(labels).toEqual(
    expect.arrayContaining([
      'Test Bar 3.0 · People',
      'Test Guest House 2.0 · People',
      'Test Bar 3.0 – Kitchen Store · Supply (view)',
      'Test Central Kitchen – Store · Supply (view)',
    ]),
  );
  expect(labels).not.toContain('Test Company · People');
  await sw.selectOption({ label: 'Test Guest House 2.0 · People' });
  await expect(page.getByText('Working at')).toContainText('Test Guest House 2.0');
});
