import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Tasks, maintenance and expired batches (ADR 020), on the test customers' data (files 29
// to 32): who gives out work, who does it, and what their leads see.

async function userId(username: string): Promise<string> {
  const rows = await asMigrator<{ id: string }>(
    'select id from core.app_user where username = $1',
    [username],
  );
  return rows[0]!.id;
}

const main = (page: Page) => page.locator('main');

test('the executive chef gives the commis a task; an out-of-range reading is flagged', async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN');
  const title = `Check the blast chiller ${Date.now()}`;
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/tasks/new?node=${kitchen}`);
  await main(page).getByRole('textbox', { name: 'Title' }).fill(title);
  await main(page).getByLabel('Time').fill('23:59');
  await main(page)
    .getByRole('combobox', { name: 'Person' })
    .selectOption(await userId('test.commis.1.0'));
  await main(page)
    .getByRole('textbox', { name: /^Steps/ })
    .fill('Blast chiller | 0-5 °C\nDoor closed');
  await main(page).getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByTestId('task-title')).toHaveText(title);
  await expect(page.getByTestId('task-status')).toContainText('With Test Commis 1.0');

  await signInAs(page, 'Test Commis 1.0');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks' }).click();
  // the seeded deep clean was due yesterday (file 30)
  await expect(page.getByTestId('tasks-overdue')).toContainText('Deep clean the walk-in chiller');
  await main(page).getByRole('link', { name: title }).click();
  await main(page).getByRole('textbox', { name: 'Blast chiller' }).fill('9');
  await expect(main(page)).toContainText('Outside 0 to 5 °C');
  // what was done about it, before it is saved (ADR 088)
  await main(page).getByRole('button', { name: 'Save' }).click();
  await expect(main(page).getByRole('alert')).toContainText('Say what you did about it.');
  await main(page).getByLabel('What did you do about it?').fill('Moved it to the walk-in');
  await main(page).getByRole('button', { name: 'Save' }).click();
  await expect(main(page).getByRole('status')).toHaveText(
    'Outside the range: your lead has been told.',
  );
  await main(page).getByRole('button', { name: 'Done' }).click();
  await main(page).getByRole('button', { name: 'Mark task done' }).click();
  await expect(page.getByTestId('task-status')).toHaveText(/^Done/);

  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto('/notifications');
  await expect(main(page)).toContainText(`${title}: Blast chiller is 9 °C`);
  await page.goto(`/tasks/team?node=${kitchen}`);
  const row = page.getByTestId('team-today').getByRole('link', { name: new RegExp(title) });
  await expect(row).toContainText('1 flagged');
  await expect(page.getByTestId('completion')).toContainText('Kitchen');
});

test('a problem goes to Engineering, who assigns the technician', async ({ page }) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN');
  const title = `Fryer pilot light out ${Date.now()}`;
  await signInAs(page, 'Test Commis 1.0');
  await page.goto(`/tasks/maintenance/new?node=${kitchen}`);
  // what is wrong is a tap; "Other" asks for the words (ADR 113)
  await main(page).getByRole('button', { name: 'Other' }).click();
  await main(page).getByRole('textbox', { name: 'What is wrong' }).fill(title);
  await main(page).getByRole('button', { name: 'Send to maintenance' }).click();
  await expect(page.getByTestId('repair-status')).toContainText(
    'Handled by Test Hotel & Bar 1.0 – Engineering · not assigned yet',
  );

  await signInAs(page, 'Test Chief Engineer 1.0');
  // approvals are in the header for a department head (UX-6)
  await page.getByRole('link', { name: /^To do list/ }).click();
  const toAssign = page.getByTestId('to-assign');
  // the seeded dishwasher request (file 31) waits too
  await expect(toAssign).toContainText('Dishwasher leaking at the door');
  await toAssign.getByRole('link', { name: new RegExp(title) }).click();
  await main(page)
    .getByRole('combobox', { name: 'Technician' })
    .selectOption(await userId('test.technician.1.0'));
  await main(page).getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByTestId('repair-status')).toContainText(
    'assigned with Test Technician 1.0',
  );

  await signInAs(page, 'Test Technician 1.0');
  // a technician's day is their repairs: on Home, counted on the Tasks tile (ADR 052)
  await page.goto('/');
  await expect(page.getByTestId('home-repairs')).toContainText(title);
  await expect(page.getByTestId('tasks-card')).not.toContainText('Nothing due today');
  await page.goto('/tasks');
  await page
    .getByTestId('my-repairs')
    .getByRole('link', { name: new RegExp(title) })
    .click();
  await main(page).getByRole('button', { name: 'Start the repair' }).click();
  await expect(page.getByTestId('repair-status')).toContainText('in progress with');
  // closing needs a photo of the fix (no photo bucket in this environment)
  await expect(main(page).getByRole('button', { name: 'Mark fixed' })).toBeDisabled();
});

test('an expired batch: reported, assigned by the chef, thrown away and remade, traced in costs', async ({
  page,
}) => {
  const store = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Commis 1.0');
  await page.goto(`/stock/production?node=${store}`);
  const expired = page
    .getByTestId('expired')
    .getByRole('listitem')
    .filter({ hasText: 'Mint Chutney' });
  await expired.getByRole('button', { name: 'Report' }).click();
  await expect(expired.getByRole('status')).toHaveText('Reported');

  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto('/inbox');
  await page
    .getByTestId('to-assign')
    .getByRole('link', { name: /Discard expired Mint Chutney/ })
    .click();
  await main(page)
    .getByRole('combobox', { name: 'Who' })
    .selectOption(await userId('test.commis-b.1.0'));
  await main(page).getByRole('button', { name: 'Assign discard and remake' }).click();
  await expect(page.getByTestId('task-title')).toContainText('Discard and remake Mint Chutney');
  await expect(page.getByTestId('task-status')).toContainText('With Test Commis B 1.0');

  await signInAs(page, 'Test Commis B 1.0');
  await page.goto('/tasks');
  await main(page)
    .getByRole('link', { name: /Discard and remake Mint Chutney/ })
    .click();
  // the quantity left is filled in
  await expect(
    main(page).getByRole('textbox', { name: 'Throw it away and record the wastage' }),
  ).toHaveValue('140');
  await main(page).getByRole('button', { name: 'Record as expired wastage' }).click();
  await expect(main(page)).toContainText('Thrown away: 140 g');
  await main(page).getByRole('textbox', { name: 'Make a new batch' }).fill('500');
  await main(page).getByRole('button', { name: 'Record the batch' }).click();
  await expect(page.getByTestId('task-status')).toHaveText(/^Done/);

  await signInAs(page, 'Test Cost Controller 1.0');
  await page.goto('/reports/cost');
  const line = page
    .getByTestId('expired-wastage')
    .getByRole('listitem')
    .filter({ hasText: 'Mint Chutney' });
  await expect(line).toContainText('reported by Test Commis 1.0');
  await expect(line).toContainText('thrown away by Test Commis B 1.0');
  await expect(line).toContainText('remade 500 g');
});

test('staff see only their own tasks; task screens refuse them', async ({ page }) => {
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/tasks');
  // a task for their job role at Bar 3.0 (file 30)
  await expect(page.getByTestId('tasks-upcoming')).toContainText('Wipe down the menu cards');
  await expect(
    page.getByRole('navigation', { name: 'Tasks' }).getByRole('link', { name: 'Team' }),
  ).toHaveCount(0);
  await expect(main(page).getByRole('link', { name: 'New task' })).toHaveCount(0);
  await page.goto('/tasks/team');
  await expect(main(page)).toContainText("You don't see a team's tasks anywhere.");
  await page.goto('/tasks/new');
  await expect(main(page)).toContainText("You don't give out tasks anywhere.");
});

test('checklists: the executive chef sees the kitchen rounds; supervisors read them', async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/tasks/checklists?node=${kitchen}`);
  const list = page.getByTestId('checklists');
  await expect(list).toContainText('Kitchen opening');
  await expect(list).toContainText('Daily at 07:00');
  await expect(main(page).getByRole('link', { name: 'New checklist' })).toBeVisible();
  await list.getByRole('link', { name: /Kitchen opening/ }).click();
  await expect(main(page).getByRole('textbox', { name: /^Steps/ })).toHaveValue(
    /Walk-in chiller temperature \| 0-5 °C/,
  );
});

test('the prep list suggests par minus what is on hand', async ({ page }) => {
  const store = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/tasks/prep?node=${store}`);
  const lines = page.getByTestId('prep-lines');
  await expect(lines).toContainText('Mint Chutney');
  await expect(lines).toContainText('Ginger Garlic Paste');
  await expect(main(page).getByRole('button', { name: /Create prep tasks/ })).toBeVisible();
});
