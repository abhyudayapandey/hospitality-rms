import { expect, test, type Page } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Handing a task on (ADR 074) at 380 px: the Passport Hotel case on Test Hotel 1.0. Its pest
// control sits at the hotel itself; the GM answers for it and the Executive Housekeeper does
// it. She gives it to her supervisor (no error after Assign, and she still follows it under
// "Given to others", on Home too); the supervisor sees when it reached her and that it was
// already overdue then, and gives it to a room attendant; the GM sees who has it. Who may
// do what, for every way a task is assigned, is proved in
// packages/db/src/task-handover.db.test.ts. Put back afterwards.

test.use({ viewport: { width: 380, height: 900 } });

const EH = 'Test Executive Housekeeper 1.0';
const HS = 'Test Housekeeping Supervisor 1.0';
const RA = 'Test Room Attendant 1.0';
const GM = 'Test General Manager 1.0';

async function pest() {
  const [t] = await asMigrator<{ id: string }>(
    `select t.id from ops.task t join ops.compliance_item i on i.id = t.compliance_item_id
      where i.name = 'Pest control service' and t.status in ('open', 'in_progress')`,
    [],
  );
  return t!.id;
}

async function userId(name: string) {
  const [u] = await asMigrator<{ id: string }>(
    `select id from core.app_user where display_name = $1`,
    [name],
  );
  return u!.id;
}

async function give(page: Page, to: string) {
  const form = page.getByTestId('reassign');
  await form.getByLabel('Give it to someone').selectOption(await userId(to));
  await form.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByTestId('task-status')).toContainText(`With ${to} since`);
}

test('the housekeeper gives pest control to her supervisor, who gives it on; everyone follows it', async ({
  page,
}) => {
  const task = await pest();
  try {
    // her To do list has it (her job role's), and its page offers to give it to someone
    await signInAs(page, EH);
    await page.goto('/tasks');
    await page
      .getByRole('link', { name: /Pest control service/ })
      .first()
      .click();
    await page.waitForURL(`**/tasks/${task}`);
    await give(page, HS);
    // no error after Assign: the page is still hers, with the history
    await expect(page.getByTestId('handover-history')).toContainText(`${EH} gave it to ${HS}`);
    await expect(page.getByTestId('task-fair')).toContainText(
      `It was already overdue when it was given to ${HS}`,
    );
    // Given to others, on her To do list and on Home
    await page.goto('/tasks');
    const given = page.getByTestId('tasks-given');
    await expect(given).toContainText('Pest control service');
    await expect(given.getByTestId('task-who')).toContainText(`${HS} · given today`);
    await page.goto('/');
    await expect(page.getByTestId('handed-on-who')).toContainText(`${HS} · given today`);

    // the supervisor: it is hers, one line with a red dot for late; who gave it and that it
    // was already overdue then are for those who follow it, not her (ADR 098)
    await signInAs(page, HS);
    await page.goto('/tasks');
    const row = page.getByRole('link', { name: /Pest control service/ }).first();
    await expect(row.getByTestId('task-late')).toBeVisible();
    await expect(row).not.toContainText('overdue when given');
    await row.click();
    await page.waitForURL(`**/tasks/${task}`);
    await give(page, RA);

    // the housekeeper still opens it, and may take it back
    await signInAs(page, EH);
    await page.goto(`/tasks/${task}`);
    await expect(page.getByTestId('task-status')).toContainText(`With ${RA} since`);
    await expect(page.getByTestId('handover-history').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('reassign')).toBeVisible();

    // the GM, who answers for it: the regular job says who has it and since when
    await signInAs(page, GM);
    await page.goto('/compliance?tab=jobs');
    await expect(
      page.getByTestId('job').filter({ hasText: 'Pest control service' }).getByTestId('job-people'),
    ).toContainText(`(with ${RA} since today`);
    await page.goto(`/tasks/${task}`);
    await expect(page.getByTestId('task-status')).toContainText(`With ${RA}`);
  } finally {
    await asMigrator(`delete from ops.task_handover where task_id = $1`, [task]);
    await asMigrator(
      `update ops.task set assignee_user_id = null, assign_mode = 'job_role', assigned_by = null
        where id = $1`,
      [task],
    );
  }
});

test('swaps for management only: a server has no Swaps; the bar manager does', async ({ page }) => {
  // Test Company lets staff swap (file 00); for this test it keeps swaps for managers
  const setting = (on: boolean) =>
    asMigrator(
      `update core.tenant set settings = settings || jsonb_build_object('swaps_managers_only', $1::boolean)
        where code = 'TEST-COMPANY'`,
      [on],
    );
  await setting(true);
  try {
    await signInAs(page, 'Test Server 3.0');
    await page.goto('/roster/my');
    await expect(page.getByRole('link', { name: 'Swaps', exact: true })).toHaveCount(0);
    await page.goto('/me');
    await expect(page.getByRole('link', { name: 'Swaps', exact: true })).toHaveCount(0);
    await signInAs(page, 'Test Bar Manager 3.0');
    await page.goto('/roster/my');
    await expect(page.getByRole('link', { name: 'Swaps', exact: true })).toHaveCount(1);
  } finally {
    await setting(false);
  }
});
