import { addDays, localToday } from '../lib/dates';
import { expect, test } from '@playwright/test';
import { asMigrator, dueWhenWorking, signInAs, takePhoto } from './helpers';

// Fewer words, tap instead of type (ADR 099), at 380 px: a reading shows its safe range first
// and coloured numbers to tap; a task's who-and-when sits under History; one's own To do list
// is one line a task with done ones folded; leave starts from the shifts you work (ADR 112).

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: import('@playwright/test').Page) => page.locator('main');

async function readingTask(title: string) {
  const [t] = await asMigrator<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode, job_role_code)
     select tenant_id, id, 'checklist', $1, $2::timestamptz, 'job_role', 'COMMIS'
       from core.hierarchy_node where code = 'TEST-HOTEL-1.0-KITCHEN'
     returning id`,
    [title, await dueWhenWorking('Test Commis 1.0')],
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
    // who it is for is under History, open for everyone (ADR 163)
    await expect(main(page).getByTestId('task-more')).toBeVisible();
    await expect(main(page).getByTestId('reading-range')).toHaveText('0 to 5 °C is good');
    const picks = main(page).getByTestId('reading-picks').getByRole('button');
    await expect(picks).toHaveText(['-1', '0', '1', '2', '3', '4', '5', '6']);
    await picks.filter({ hasText: /^3$/ }).click();
    await expect(main(page).getByRole('textbox', { name: 'Walk-in chiller' })).toHaveValue('3');
    // − and + move it by one
    await main(page).getByRole('button', { name: 'More', exact: true }).click();
    await expect(main(page).getByRole('textbox', { name: 'Walk-in chiller' })).toHaveValue('4');
    // a photo of every step (ADR 127)
    await takePhoto(main(page));
    await main(page).getByRole('button', { name: 'Done' }).click();
    await expect(main(page).getByText('Acceptable: 0 to 5 °C')).toBeVisible();
  } finally {
    await asMigrator(`delete from ops.task_step where task_id = $1`, [task]);
    await asMigrator(`delete from ops.task where id = $1`, [task]);
  }
});

test('the To do list: one line a task, done ones folded into one row', async ({ page }) => {
  // a frontline person with a task to do: rounds follow the roster (ADR 148), and most test
  // people work Monday to Friday, so on a Friday the room attendant's next round is Monday's
  const [who] = await asMigrator<{ name: string }>(
    `select u.display_name as name from core.app_user u
       join unnest($1::text[]) with ordinality c(username, n) on c.username = u.username
      where exists (select 1 from ops.task t
                     where t.status in ('open', 'in_progress')
                       and t.due_at < now() + interval '2 days'
                       and (t.assignee_user_id = u.id or ops.in_pool(t, u.id)))
      order by c.n limit 1`,
    [['test.room-attendant.1.0', 'test.commis.1.0', 'test.server.3.0', 'test.commis-b.1.0']],
  );
  await signInAs(page, who!.name);
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

test('leave: nothing is chosen until tapped; it never starts on today (ADR 153)', async ({
  page,
}) => {
  await signInAs(page, 'Test Commis 1.0');
  await page.goto('/leave');
  const form = page.getByRole('form', { name: 'Request leave' });
  const type = form.getByRole('group', { name: 'Type' }).getByRole('button');
  await expect(type.first()).toHaveAttribute('aria-pressed', 'false');
  await expect(form.getByRole('button', { name: 'Pick the type of leave' })).toBeDisabled();
  await type.first().click();
  await expect(form.getByRole('button', { name: 'Pick the days off' })).toBeDisabled();
  const fold = form.getByTestId('leave-dates');
  if ((await fold.getAttribute('open')) === null) await fold.locator('summary').click();
  const today = localToday('Asia/Kolkata');
  await expect(form.getByLabel('From', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('From', { exact: true })).toHaveAttribute('min', addDays(today, 1));
  await form.getByLabel('From', { exact: true }).fill(addDays(today, 3));
  await form.getByLabel('To', { exact: true }).fill(addDays(today, 4));
  await expect(main(page).getByRole('button', { name: /Request 2 days/ })).toBeVisible();
});
