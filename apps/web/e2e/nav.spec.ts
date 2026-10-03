import { expect, test } from '@playwright/test';
import { newSession, SESSION_COOKIE, signSession } from '../lib/auth/session';
import { asMigrator, signInAs } from './helpers';

// Bottom navigation: three to five tabs, chosen by the kind of work a person does (UX-6,
// ADR 034); the pages themselves are enforced in the DB. These rows follow the mock-ups.
const cases: [string, string[]][] = [
  // frontline: Home, Tasks, Me; their four tiles on Home do the rest
  ['Test Commis 1.0', ['Home', 'Tasks', 'Me']],
  ['Test Bartender 1.0', ['Home', 'Tasks', 'Me']],
  ['Test Server 3.0', ['Home', 'Tasks', 'Me']],
  ['Test Room Attendant 1.0', ['Home', 'Tasks', 'Me']],
  ['Test Technician 1.0', ['Home', 'Tasks', 'Me']],
  ['Test Store Keeper 1.0', ['Home', 'Stock', 'Tasks', 'Me']],
  // department heads: approvals on Home
  ['Test Head Cook 3.0', ['Home', 'Roster', 'Stock', 'Reports', 'Me']],
  ['Test Executive Chef 1.0', ['Home', 'Roster', 'Stock', 'Reports', 'Me']],
  ['Test Chief Engineer 1.0', ['Home', 'Roster', 'Tasks', 'Reports', 'Me']],
  ['Test General Manager 1.0', ['Home', 'Approvals', 'Reports', 'Me']],
  ['Test Bar Manager 3.0', ['Home', 'Approvals', 'Reports', 'Me']],
  ['Test Area Manager', ['Home', 'Approvals', 'Reports', 'Me']],
  ['Test Cost Controller 1.0', ['Home', 'Stock', 'Reports', 'Approvals', 'Me']],
  ['Test HR Admin', ['Home', 'Approvals', 'Reports', 'Roster', 'Me']],
  ['Test Account Owner', ['Home', 'Approvals', 'Reports', 'Admin', 'Me']],
];

for (const [who, items] of cases) {
  test(`nav for ${who}`, async ({ page }) => {
    await signInAs(page, who);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByTestId('nav-label')).toHaveText(items);
  });
}

test('Me has every screen the tabs leave out', async ({ page }) => {
  await signInAs(page, 'Test Server 3.0');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Me', exact: true }).click();
  await page.getByTestId('me-requests').click();
  await expect(page).toHaveURL(/\/requests$/);
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/me');
  await expect(page.getByTestId('me-admin')).toBeVisible();
  await expect(page.getByTestId('me-roster')).toBeVisible();
  // a tab is not repeated on Me
  await expect(page.getByTestId('me-reports')).toHaveCount(0);
  // approvals are in the header for people without the tab
  await signInAs(page, 'Test Commis 1.0');
  await expect(page.getByRole('link', { name: /^Approvals/ })).toBeVisible();
});

test('everyone in both test customers gets three to five tabs', async ({ page }) => {
  test.setTimeout(300_000);
  const users = await asMigrator<{ id: string; username: string }>(
    `select u.id, u.username from core.app_user u join core.tenant t on t.id = u.tenant_id
      where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and u.kind = 'human'
        and u.status = 'active'
      order by u.username`,
    [],
  );
  expect(users.length).toBeGreaterThan(100);
  const over: string[] = [];
  for (const u of users) {
    const token = await signSession(newSession(u.id, 'cognito'), process.env.SESSION_SECRET!);
    const res = await page.request.get('/', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status(), u.username).toBe(200);
    const html = await res.text();
    const nav = /<nav aria-label="Main"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    const n = (nav.match(/<a /g) ?? []).length;
    if (n < 3 || n > 5) over.push(`${u.username}: ${n}`);
  }
  expect(over).toEqual([]);
});

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
