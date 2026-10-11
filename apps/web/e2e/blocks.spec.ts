import { expect, test } from '@playwright/test';
import { asMigrator, signInAs, signInPlatform } from './helpers';

// Building blocks (ADR 026, 067, 085) at 380 px. Test Solo Bar Co. has Events and Swaps off
// (file 00); Test Company has every block on. Only a platform admin switches a block or puts a
// bundle in or out, on the customer's console page; nobody in the customer can, the owner
// included, who sees the plan read-only in Admin → Your plan. The customer's settings are put
// back as they were afterwards. Who may do what is proved in packages/db/src/blocks.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

test('a company without Events and Swaps: they are gone from Roster and Home, and say why', async ({
  page,
}) => {
  await signInAs(page, 'Test Server');
  await page.goto('/roster/my');
  await expect(
    page.getByRole('navigation', { name: 'Me', exact: true }).getByRole('link'),
  ).toHaveText(['Shifts', 'Clock', 'Leave']);
  await expect(page.getByRole('link', { name: 'Swap', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('events-this-week')).toHaveCount(0);
  await page.goto('/events');
  await expect(page.getByTestId('module-off')).toContainText(
    "Events isn't switched on for your company. Ask Outlet Ops to switch it on.",
  );
  await page.goto('/');
  expect(await page.getByRole('main').getByRole('link').allInnerTexts()).not.toContain('Events');

  // Test Company keeps both
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/roster/my');
  await expect(page.getByRole('navigation', { name: 'Me', exact: true })).toContainText('Swaps');
});

test('the platform admin switches a block and a bundle; the cook sees them go; the owner only looks', async ({
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
    // the owner: the plan read-only, no switch anywhere
    const owner = await browser.newPage({ viewport: { width: 380, height: 900 } });
    await signInAs(owner, 'Test Bar Manager');
    await owner.goto('/admin');
    await owner.getByRole('link', { name: 'Your plan' }).click();
    const mine = owner.getByTestId('modules');
    await expect(mine.getByRole('switch')).toHaveCount(0);
    const people = mine.getByRole('region', { name: 'People' });
    await expect(people.getByTestId('bundle-state')).toHaveText('In your plan');
    await expect(people.locator('[data-module="swaps"]').getByTestId('module-state')).toHaveText(
      'Off',
    );
    await expect(
      mine.getByRole('region', { name: 'Hotel' }).getByTestId('bundle-state'),
    ).toHaveText('Not in your plan');

    await signInPlatform(page);
    await page.goto(`/platform/customers/${id}`);
    const card = page.getByTestId('bundles');
    const daily = card.getByRole('region', { name: 'Daily work' });
    const maintenance = daily.getByRole('switch', { name: 'Maintenance' });
    await expect(maintenance).toHaveText('On');

    // one block off: asks first; Keep on changes nothing
    await maintenance.click();
    const confirm = page.getByRole('group', { name: 'Turn off Maintenance' });
    await expect(confirm).toContainText('It stops for everyone at Test Solo Bar Co.');
    await confirm.getByRole('button', { name: 'Keep on' }).click();
    await expect(maintenance).toHaveText('On');
    await maintenance.click();
    await confirm.getByRole('button', { name: 'Turn off' }).click();
    await expect(maintenance).toHaveText('Off');

    const cook = await browser.newPage({ viewport: { width: 380, height: 900 } });
    await signInAs(cook, 'Test Cook');
    await cook.goto('/tasks');
    await expect(cook.getByRole('link', { name: 'Report a problem' })).toHaveCount(0);
    await cook.goto('/tasks/maintenance/new');
    await expect(cook.getByTestId('module-off')).toContainText("Maintenance isn't switched on");
    await owner.reload();
    await expect(
      mine.locator('[data-module="maintenance"]').getByTestId('module-state'),
    ).toHaveText('Off');

    // a whole bundle out of the plan: every part of it goes
    const dailyPlan = daily.getByRole('switch', { name: 'Daily work' });
    await dailyPlan.click();
    await page
      .getByRole('group', { name: 'Turn off Daily work' })
      .getByRole('button', { name: 'Turn off' })
      .click();
    await expect(dailyPlan).toHaveText('Off');
    await expect(daily.getByRole('switch', { name: 'Checklists' })).toHaveCount(0);
    await cook.goto('/briefing');
    await expect(cook.getByTestId('module-off')).toContainText(
      "Daily work isn't part of your company's plan. Ask Outlet Ops to add it.",
    );

    // back in the plan: every block in it on again, Maintenance included
    await dailyPlan.click();
    await expect(dailyPlan).toHaveText('On');
    await expect(daily.getByRole('switch', { name: 'Maintenance' })).toHaveText('On');
    await cook.goto('/tasks');
    await expect(cook.getByRole('link', { name: 'Report a problem' })).toBeVisible();
  } finally {
    await asMigrator(`update core.tenant set settings = $2::jsonb where id = $1`, [
      id,
      JSON.stringify(settings),
    ]);
  }
});
