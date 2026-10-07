import { expect, test } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Modules on or off per company (UX-3b, ADR 026). Test Solo Bar Co. has Events and Swaps
// off (file 00); Test Company has every module on. The solo owner turns Maintenance off and
// on again here; the file's state is put back afterwards.

const SOLO_FILE = '{"events": false, "swaps": false}';

test.afterAll(async () => {
  await asMigrator(
    `update core.tenant set settings = jsonb_set(settings, '{modules}', $1::jsonb)
      where code = 'TEST-SOLO-COMPANY'`,
    [SOLO_FILE],
  );
});

test('a company without Events and Swaps: they are gone from Roster and Home, and say why', async ({
  page,
}) => {
  await signInAs(page, 'Test Server');
  await page.goto('/roster/my');
  await expect(
    page.getByRole('navigation', { name: 'Me', exact: true }).getByRole('link'),
  ).toHaveText(['My shifts', 'Clock', 'Leave']);
  await expect(page.getByRole('link', { name: 'Swap', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('events-this-week')).toHaveCount(0);

  for (const [href, name] of [
    ['/events', 'Events'],
    ['/roster/swaps', 'Shift swaps'],
  ] as const) {
    await page.goto(href);
    await expect(page.getByTestId('module-off')).toContainText(
      `${name} isn't switched on for your company.`,
    );
  }

  await page.goto('/');
  const links = await page.getByRole('main').getByRole('link').allInnerTexts();
  expect(links).not.toContain('Events');

  // Test Company keeps both
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/roster/my');
  await expect(page.getByRole('navigation', { name: 'Me', exact: true })).toContainText('Swaps');
});

test('the owner turns Maintenance off and on; the cook sees it go and come back', async ({
  page,
}) => {
  await signInAs(page, 'Test Bar Manager');
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Modules' }).click();
  const list = page.getByTestId('modules');
  await expect(list.getByRole('switch', { name: 'Events' })).toHaveText('Off');
  const maintenance = list.getByRole('switch', { name: 'Maintenance' });
  await expect(maintenance).toHaveText('On');

  // turning off asks first; Keep on changes nothing
  await maintenance.click();
  const confirm = page.getByRole('group', { name: 'Turn off Maintenance' });
  await confirm.getByRole('button', { name: 'Keep on' }).click();
  await expect(maintenance).toHaveText('On');
  await maintenance.click();
  await confirm.getByRole('button', { name: 'Turn off' }).click();
  await expect(maintenance).toHaveText('Off');

  await signInAs(page, 'Test Cook');
  await page.goto('/tasks');
  await expect(page.getByRole('link', { name: 'Report a problem' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Maintenance', exact: true })).toHaveCount(0);
  await page.goto('/tasks/maintenance/new');
  await expect(page.getByTestId('module-off')).toContainText("Maintenance isn't switched on");

  await signInAs(page, 'Test Bar Manager');
  await page.goto('/admin/modules');
  await page.getByTestId('modules').getByRole('switch', { name: 'Maintenance' }).click();
  await expect(page.getByTestId('modules').getByRole('switch', { name: 'Maintenance' })).toHaveText(
    'On',
  );

  await signInAs(page, 'Test Cook');
  await page.goto('/tasks');
  await expect(page.getByRole('link', { name: 'Report a problem' })).toBeVisible();
});

test('other administrators see the modules but cannot change them', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/admin/modules');
  const list = page.getByTestId('modules');
  await expect(list.getByRole('switch')).toHaveCount(0);
  await expect(list.getByTestId('module-state')).toHaveCount(9);
  await expect(page.getByText('Only the account owner can change these.')).toBeVisible();
});
