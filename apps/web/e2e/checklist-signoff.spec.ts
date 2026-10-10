import { expect, test, type Page } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// A second signature (ADR 087) at 380 px, on Test Hotel 1.0's linen room count (file 29
// `sign_off` = up). The room attendant counts and finishes it; the housekeeping supervisor,
// one level up, gets it to sign off, sends it back once, then signs it off. Who may and may
// not is proved in packages/db/src/checklist-signoff.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const RA = 'Test Room Attendant 1.0';
const HS = 'Test Housekeeping Supervisor 1.0';
const main = (page: Page) => page.locator('main');

/** A round of the linen count, due within the hour, with its steps. */
async function linenRound(): Promise<string> {
  const [t] = await asMigrator<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,
                           job_role_code, template_id)
     select c.tenant_id, c.org_node_id, 'checklist', c.name,
            date_trunc('second', now()) + interval '1 hour' + random() * interval '1000 seconds',
            'job_role', 'ROOM_ATTENDANT', c.id
       from ops.checklist_template c where c.code = 'HOTEL-1.0-HK-LINEN'
     returning id`,
    [],
  );
  await asMigrator(
    `select ops.add_steps(t, c.steps) from ops.task t, ops.checklist_template c
      where t.id = $1 and c.id = t.template_id`,
    [t!.id],
  );
  return t!.id;
}

async function count(page: Page, task: string, towels: string, sheets: string) {
  await page.goto(`/tasks/${task}`);
  await main(page).getByLabel('Bath towels on the shelf').fill(towels);
  await main(page).getByRole('button', { name: 'Save' }).click();
  await main(page).getByLabel('Bed sheets on the shelf').fill(sheets);
  // under 80 is out of range: say what was done about it (ADR 088)
  if (Number(sheets) < 80) {
    await main(page).getByLabel('What did you do about it?').fill('Asked the laundry for more');
  }
  await main(page).getByRole('button', { name: 'Save' }).click();
  await main(page).getByRole('button', { name: 'Mark task done' }).click();
}

async function openSignOff(page: Page, task: string): Promise<string> {
  const [s] = await asMigrator<{ id: string }>(
    `select id from ops.task where signs_off = $1 and status = 'open'`,
    [task],
  );
  // it is on the supervisor's To do list
  await page.goto('/tasks');
  await expect(
    page.getByRole('link', { name: /Sign off: Linen room count/ }).first(),
  ).toBeVisible();
  await page.goto(`/tasks/${s!.id}`);
  await expect(page.getByTestId('sign-off-about')).toContainText(`${RA} finished`);
  return s!.id;
}

test('the attendant counts, the supervisor sends it back once, then signs it off', async ({
  page,
}) => {
  const task = await linenRound();
  try {
    await signInAs(page, RA);
    await count(page, task, '130', '70');
    await expect(page.getByTestId('sign-off-status')).toHaveText(`Waiting for sign-off by ${HS}`);

    await signInAs(page, HS);
    await openSignOff(page, task);
    await expect(main(page).getByTestId('step')).toHaveCount(2);
    await main(page).getByText('Send it back', { exact: true }).click();
    await main(page).getByLabel('What to redo').fill('Count the sheets again');
    await main(page).getByRole('button', { name: 'Send back', exact: true }).click();
    await expect(page.getByTestId('task-status')).toHaveText(/^Done/);

    await signInAs(page, RA);
    await page.goto(`/tasks/${task}`);
    await expect(page.getByTestId('sent-back')).toHaveText(
      'Sent back to redo: Count the sheets again',
    );
    await count(page, task, '130', '90');

    await signInAs(page, HS);
    await openSignOff(page, task);
    await main(page).getByRole('button', { name: 'Sign it off' }).click();
    await expect(page.getByTestId('task-status')).toHaveText(/^Done/);

    await signInAs(page, RA);
    await page.goto(`/tasks/${task}`);
    await expect(page.getByTestId('sign-off-status')).toContainText(`Signed off by ${HS}`);
    await expect(main(page).getByTestId('step-checked')).toHaveCount(2);
  } finally {
    await asMigrator(
      `with s as (select id from ops.task where signs_off = $1 or id = $1)
       delete from ops.task_step where task_id in (select id from s)`,
      [task],
    );
    await asMigrator(`delete from ops.task where signs_off = $1`, [task]);
    await asMigrator(`delete from ops.task where id = $1`, [task]);
  }
});
