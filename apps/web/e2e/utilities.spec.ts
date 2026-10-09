import { expect, test, type Page } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Utilities (ADR 091) at 380 px on Test Hotel 1.0. The technician's meter round is on his To
// do list; he reads the four meters, and the chief engineer sees today's readings. Who may is
// proved in packages/db/src/utilities.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');
const CODE = 'METERS-TEST-HOTEL-1.0-ENGINEERING-TECHNICIAN-0900';

test('the technician reads the meters; the chief engineer sees the readings', async ({ page }) => {
  const [t] = await asMigrator<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,
                           job_role_code, template_id)
     select c.tenant_id, c.org_node_id, 'checklist', c.name,
            date_trunc('second', now()) + interval '1 hour' + random() * interval '1000 seconds',
            'job_role', 'TECHNICIAN', c.id
       from ops.checklist_template c where c.code = $1
     returning id`,
    [CODE],
  );
  const task = t!.id;
  await asMigrator(
    `select ops.add_steps(t, c.steps) from ops.task t, ops.checklist_template c
      where t.id = $1 and c.id = t.template_id`,
    [task],
  );
  try {
    await signInAs(page, 'Test Technician 1.0');
    await page.goto(`/tasks/${task}`);
    for (const [label, value] of [
      ['Electricity main', '45210'],
      ['Generator diesel', '310'],
      ['Kitchen gas', '1288'],
      ['Water inlet', '902'],
    ] as const) {
      await main(page).getByLabel(label).fill(value);
      await main(page).getByRole('button', { name: 'Save' }).click();
      await expect(main(page).getByTestId('step').filter({ hasText: label })).toContainText(
        '✓ done',
      );
    }
    await main(page).getByRole('button', { name: 'Mark task done' }).click();
    await expect(page.getByTestId('task-status')).toHaveText(/^Done/);

    await signInAs(page, 'Test Chief Engineer 1.0');
    await page.goto('/utilities');
    const meter = main(page).getByTestId('meter').filter({ hasText: 'Electricity main' });
    await expect(meter.getByTestId('meter-day').first()).toContainText('45,210');
  } finally {
    await asMigrator(
      `delete from ops.meter_reading where task_step_id in (
         select id from ops.task_step where task_id = $1)`,
      [task],
    );
    await asMigrator(`delete from ops.task_step where task_id = $1`, [task]);
    await asMigrator(`delete from ops.task where id = $1`, [task]);
  }
});
