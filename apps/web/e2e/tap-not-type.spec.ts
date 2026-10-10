import { expect, test } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Fewer words, tap instead of type (ADR 099), at 380 px: a reading shows its safe range first
// and coloured numbers to tap; a task's who-and-when sits under History; one's own To do list
// is one line a task with done ones folded; leave starts from Today and a length.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: import('@playwright/test').Page) => page.locator('main');

async function readingTask(title: string) {
  const [t] = await asMigrator<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode, job_role_code)
     select tenant_id, id, 'checklist', $1, now() + interval '2 hours', 'job_role', 'COMMIS'
       from core.hierarchy_node where code = 'TEST-HOTEL-1.0-KITCHEN'
     returning id`,
    [title],
  );
  await asMigrator(
    `insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind, min_value,
                                max_value, unit)
     select tenant_id, id, org_node_id, 1, 'Walk-in chiller', 'number', 0, 5, '°C'
       from ops.task where id = $1`,
    [t!.id],
  );
  return t!.id;
}

test('a reading: the safe range first, a number tapped, and the task done', async ({ page }) => {
  const title = `Chiller check ${Date.now()}`;
  const task = await readingTask(title);
  try {
    await signInAs(page, 'Test Commis 1.0');
    await page.goto(`/tasks/${task}`);
    await expect(main(page).getByTestId('task-due')).toContainText('Due');
    // who it is for is under History, folded for the person doing it
    await expect(main(page).getByTestId('task-more')).not.toHaveAttribute('open', '');
    await expect(main(page).getByTestId('reading-range')).toHaveText('0 to 5 °C is good');
    const picks = main(page).getByTestId('reading-picks').getByRole('button');
    await expect(picks).toHaveText(['-1', '0', '1', '2', '3', '4', '5', '6', '7']);
    await picks.filter({ hasText: /^3$/ }).click();
    await expect(main(page).getByRole('textbox', { name: 'Walk-in chiller' })).toHaveValue('3');
    // − and + move it by one
    await main(page).getByRole('button', { name: 'More', exact: true }).click();
    await expect(main(page).getByRole('textbox', { name: 'Walk-in chiller' })).toHaveValue('4');
    await main(page).getByRole('button', { name: 'Save' }).click();
    await expect(main(page).getByText('Acceptable: 0 to 5 °C')).toBeVisible();
  } finally {
    await asMigrator(`delete from ops.task_step where task_id = $1`, [task]);
    await asMigrator(`delete from ops.task where id = $1`, [task]);
  }
});

test('the To do list: one line a task, done ones folded into one row', async ({ page }) => {
  await signInAs(page, 'Test Room Attendant 1.0');
  await page.goto('/tasks');
  const rows = main(page).locator('[data-testid^="tasks-"] li');
  await expect(rows.first()).toBeVisible();
  // one's own rows say nothing of who gave them
  await expect(main(page).getByTestId('tasks-today').getByTestId('task-who')).toHaveCount(0);
  const fold = main(page).getByTestId('done-fold');
  if (await fold.count()) {
    await expect(main(page).getByTestId('tasks-done')).not.toBeVisible();
    await fold.locator('summary').click();
    await expect(main(page).getByTestId('tasks-done')).toBeVisible();
  }
  await expect(main(page).getByRole('link', { name: 'Report a problem' })).toBeVisible();
});

test('leave: Today and 2 days fill the dates', async ({ page }) => {
  await signInAs(page, 'Test Commis 1.0');
  await page.goto('/leave');
  const picks = main(page).getByTestId('leave-picks');
  await picks.getByRole('button', { name: 'Tomorrow' }).click();
  await picks.getByRole('button', { name: '2 days' }).click();
  await expect(main(page).getByRole('button', { name: /Request 2 days/ })).toBeVisible();
});
