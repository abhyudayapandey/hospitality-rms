import { expect, test, type Page } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Done stays in view (ADR 075) at 380 px, on Test Hotel 1.0. A task for the room
// attendants' job role: one does it and it stays on her To do list under Done, "Done by you";
// the other room attendant sees who did it and opens it. The Executive Housekeeper gives
// another to her supervisor: when it is done it stays under "Given to others", on Home too,
// marked Done. Who sees what is proved in packages/db/src/done-stays.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const RA = 'Test Room Attendant 1.0';
const RA_B = 'Test Room Attendant B 1.0';
const EH = 'Test Executive Housekeeper 1.0';
const HS = 'Test Housekeeping Supervisor 1.0';
const main = (page: Page) => page.locator('main');

async function roleTask(title: string): Promise<string> {
  const [t] = await asMigrator<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode, job_role_code)
     select tenant_id, id, 'one_off', $1, now() + interval '2 hours', 'job_role', 'ROOM_ATTENDANT'
       from core.hierarchy_node where code = 'TEST-HOTEL-1.0-HOUSEKEEPING'
     returning id`,
    [title],
  );
  return t!.id;
}

async function markDone(page: Page, task: string) {
  await page.goto(`/tasks/${task}`);
  await main(page).getByRole('button', { name: 'Mark task done' }).click();
  await expect(page.getByTestId('task-status')).toHaveText(/^Done/);
}

test('a done task stays on the To do list, saying who did it; the other attendant sees it', async ({
  page,
}) => {
  const title = `Turn down the suites ${Date.now()}`;
  const task = await roleTask(title);
  try {
    await signInAs(page, RA);
    await markDone(page, task);
    await page.goto('/tasks');
    // done ones fold into one row (ADR 098)
    await page.getByTestId('done-fold').locator('summary').click();
    const done = page.getByTestId('tasks-done').getByRole('link', { name: new RegExp(title) });
    await expect(done.getByTestId('task-who')).toContainText('Done by you, today');

    await signInAs(page, RA_B);
    await page.goto('/tasks');
    await page.getByTestId('done-fold').locator('summary').click();
    const theirs = page.getByTestId('tasks-done').getByRole('link', { name: new RegExp(title) });
    await expect(theirs.getByTestId('task-who')).toContainText(`Done by ${RA}, today`);
    await theirs.click();
    await expect(page.getByTestId('task-status')).toHaveText(/^Done/);
  } finally {
    await asMigrator(`delete from ops.task where id = $1`, [task]);
  }
});

test('what was given to someone else stays under Given to others, marked done', async ({
  page,
}) => {
  const title = `Restock the linen room ${Date.now()}`;
  const task = await roleTask(title);
  try {
    await signInAs(page, EH);
    await page.goto(`/tasks/${task}`);
    const [hs] = await asMigrator<{ id: string }>(
      `select id from core.app_user where display_name = $1`,
      [HS],
    );
    const form = page.getByTestId('reassign');
    await form.getByLabel('Give it to someone').selectOption(hs!.id);
    await form.getByRole('button', { name: 'Assign' }).click();
    await expect(page.getByTestId('task-status')).toContainText(`With ${HS} since`);

    await signInAs(page, HS);
    await markDone(page, task);

    await signInAs(page, EH);
    await page.goto('/tasks');
    const given = page.getByTestId('tasks-given').getByRole('link', { name: new RegExp(title) });
    await expect(given.getByTestId('task-who')).toContainText(`Done by ${HS}, today`);
    await expect(given).toContainText('done');
    await page.goto('/');
    const card = page.getByTestId('handed-on').getByRole('link', { name: new RegExp(title) });
    await expect(card).toContainText(`Done by ${HS}, today`);
    await expect(card).toContainText('Done');
  } finally {
    await asMigrator(`delete from ops.task where id = $1`, [task]);
  }
});
