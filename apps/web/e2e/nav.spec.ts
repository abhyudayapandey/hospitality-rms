import { expect, test } from '@playwright/test';
import { newSession, SESSION_COOKIE, signSession } from '../lib/auth/session';
import { asMigrator, signInAs } from './helpers';

// Bottom nav: at most five items, chosen by the kind of work a person does (ADR 020); the
// pages themselves are enforced in the DB. These rows are the approved table, in order.
const cases: [string, string[]][] = [
  ['Test Commis 1.0', ['Home', 'Tasks', 'Production', 'Roster', 'Inbox']],
  ['Test Bartender 1.0', ['Home', 'Tasks', 'Production', 'Roster', 'Inbox']],
  // frontline without approvals: Requests is on Home
  ['Test Server 3.0', ['Home', 'Tasks', 'Roster', 'Inbox']],
  ['Test Room Attendant 1.0', ['Home', 'Tasks', 'Roster', 'Inbox']],
  ['Test Technician 1.0', ['Home', 'Tasks', 'Roster', 'Inbox']],
  ['Test Store Keeper 1.0', ['Home', 'Inbox', 'Stock', 'Tasks', 'Roster']],
  ['Test Head Cook 3.0', ['Home', 'Inbox', 'Tasks', 'Roster', 'Stock']],
  ['Test Executive Chef 1.0', ['Home', 'Inbox', 'Tasks', 'Roster', 'Stock']],
  ['Test Chief Engineer 1.0', ['Home', 'Inbox', 'Tasks', 'Roster', 'Requests']],
  ['Test General Manager 1.0', ['Home', 'Inbox', 'Stock', 'Roster', 'Tasks']],
  ['Test Bar Manager 3.0', ['Home', 'Inbox', 'Stock', 'Roster', 'Tasks']],
  ['Test Area Manager', ['Home', 'Inbox', 'Stock', 'Roster', 'Tasks']],
  // Reports (ADR 023) takes Menu's place for the cost controller, and joins the office nav
  ['Test Cost Controller 1.0', ['Home', 'Inbox', 'Stock', 'Reports', 'Requests']],
  ['Test HR Admin', ['Home', 'Inbox', 'Reports', 'Roster', 'Requests']],
  ['Test Account Owner', ['Home', 'Inbox', 'Reports', 'Admin', 'Requests']],
];

for (const [who, items] of cases) {
  test(`nav for ${who}`, async ({ page }) => {
    await signInAs(page, who);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByTestId('nav-label')).toHaveText(items);
  });
}

test('Home links to what the nav leaves out', async ({ page }) => {
  await signInAs(page, 'Test Server 3.0');
  const more = page.getByRole('navigation', { name: 'More' });
  await expect(more.getByRole('link', { name: 'My requests' })).toBeVisible();
  await more.getByRole('link', { name: 'My requests' }).click();
  await expect(page).toHaveURL(/\/requests$/);
  await signInAs(page, 'Test General Manager 1.0');
  await expect(
    page.getByRole('navigation', { name: 'More' }).getByRole('link', { name: 'Admin' }),
  ).toBeVisible();
});

test('no one in either test customer gets more than five nav items', async ({ page }) => {
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
    if (n < 2 || n > 5) over.push(`${u.username}: ${n}`);
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
