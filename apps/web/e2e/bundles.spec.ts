import { expect, test } from '@playwright/test';
import { asMigrator, signInAs, signInPlatform } from './helpers';

// Selling by bundle (ADR 067) at 380 px. The platform admin turns Tasks & food safety off for
// Test Solo Bar Co. on its console page; its owner sees it read-only in Admin → Modules as
// "Not in your plan" and can't switch its modules on; a cook finds Maintenance gone. Then
// back on. The customer's settings are put back as they were in a finally block. Who may do
// what is proved in packages/db/src/bundles.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

test('the platform admin takes a bundle out of the plan; the owner sees it read-only', async ({
  page,
  browser,
}) => {
  const { id, settings } = (
    await asMigrator<{ id: string; settings: unknown }>(
      `select id, settings from core.tenant where code = 'TEST-SOLO-COMPANY'`,
      [],
    )
  )[0]!;
  try {
    await signInPlatform(page);
    await page.goto(`/platform/customers/${id}`);
    const card = page.getByTestId('bundles');
    const row = (b: string) => card.locator(`[data-bundle="${b}"]`);
    await expect(row('stock_cost').getByTestId('bundle-state')).toHaveText('On');
    // file 00 turns Swaps and Events off: worked out from the modules
    await expect(row('people_roster').getByTestId('bundle-state')).toHaveText(
      'Partly on · the customer turned Shift swaps and Events off',
    );
    const tasks = card.getByRole('switch', { name: 'Tasks & food safety' });
    await expect(tasks).toHaveText('On');

    // turning off asks first; Keep on changes nothing
    await tasks.click();
    const confirm = page.getByRole('group', { name: 'Turn off Tasks & food safety' });
    await expect(confirm).toContainText('Its parts stop for everyone at Test Solo Bar Co.');
    await confirm.getByRole('button', { name: 'Keep on' }).click();
    await expect(tasks).toHaveText('On');
    await tasks.click();
    await confirm.getByRole('button', { name: 'Turn off' }).click();
    await expect(tasks).toHaveText('Off');
    await expect(row('tasks_food_safety').getByTestId('bundle-state')).toHaveText('Off');

    // the owner: read-only, "Not in your plan", no switch for its modules
    const owner = await browser.newPage({ viewport: { width: 380, height: 900 } });
    await signInAs(owner, 'Test Bar Manager');
    await owner.goto('/admin/modules');
    const mine = owner.getByTestId('modules');
    const section = mine.getByRole('region', { name: 'Tasks & food safety' });
    await expect(section.getByTestId('bundle-state')).toHaveText('Not in your plan');
    await expect(section.getByRole('switch')).toHaveCount(0);
    await expect(section.getByTestId('module-state')).toHaveText([
      'Not in your plan',
      'Not in your plan',
    ]);
    // inside a bundle that is on, single modules still switch
    const people = mine.getByRole('region', { name: 'People & roster' });
    await expect(people.getByTestId('bundle-state')).toHaveText('On');
    await expect(people.getByRole('switch', { name: 'Leave' })).toHaveText('On');
    await expect(people.getByRole('switch', { name: 'Events' })).toHaveText('Off');

    // and its people lose the module, as if it were turned off
    const cook = await browser.newPage({ viewport: { width: 380, height: 900 } });
    await signInAs(cook, 'Test Cook');
    await cook.goto('/tasks/maintenance/new');
    await expect(cook.getByTestId('module-off')).toContainText(
      "Tasks & food safety isn't part of your company's plan. Ask Outlet Ops to add it.",
    );

    // back in the plan: on again, for the owner too
    await tasks.click();
    await expect(tasks).toHaveText('On');
    await expect(row('tasks_food_safety').getByTestId('bundle-state')).toHaveText('On');
    await owner.reload();
    await expect(section.getByTestId('bundle-state')).toHaveText('On');
    await expect(section.getByRole('switch', { name: 'Maintenance' })).toHaveText('On');
  } finally {
    await asMigrator(`update core.tenant set settings = $2::jsonb where id = $1`, [
      id,
      JSON.stringify(settings),
    ]);
  }
});
