import { expect, test, type Page } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Audits & taste panels (ADR 095) at 380 px: Test Hotel 1.0's taste panel (file 29, 1 to 5) is
// made a day ahead by the tasks job; the executive chef rates it 4, 5 and 3 and the GM reads
// 80% on Audits. Scores and who sees them are proved in packages/db/src/audits.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('the chef rates the taste panel; the GM reads its score', async ({ page }) => {
  const [round] = await asMigrator<{ at: string }>(
    `select o::text as at from ops.checklist_template t,
            ops.occurrences(t.schedule, 'Asia/Kolkata', now(), now() + interval '40 days') o
      where t.code = 'HOTEL-1.0-TASTE-PANEL' order by o limit 1`,
    [],
  );
  await asMigrator(`select * from ops.tasks_tick($1::timestamptz - interval '1 hour')`, [
    round!.at,
  ]);
  const [task] = await asMigrator<{ id: string }>(
    `select k.id from ops.task k join ops.checklist_template t on t.id = k.template_id
      where t.code = 'HOTEL-1.0-TASTE-PANEL' and k.due_at = $1::timestamptz`,
    [round!.at],
  );
  try {
    await signInAs(page, 'Test Executive Chef 1.0');
    await page.goto(`/tasks/${task!.id}`);
    for (const [label, n] of [
      ['Butter chicken: taste', '4'],
      ['Butter chicken: presentation', '5'],
      ['Dal makhani: taste', '3'],
    ] as const) {
      const step = main(page).getByTestId('step').filter({ hasText: label });
      await step.getByText(n, { exact: true }).click();
      await step.getByRole('button', { name: 'Save' }).click();
      await expect(step).toContainText(`${n} of 5`);
    }
    await main(page).getByRole('button', { name: 'Mark task done' }).click();
    await expect(page.getByTestId('task-status')).toHaveText(/^Done/);

    await signInAs(page, 'Test General Manager 1.0');
    await page.goto('/audits');
    await main(page)
      .getByRole('link', { name: /Kitchen/ })
      .first()
      .click();
    const panel = main(page).getByTestId('audit').filter({ hasText: 'Taste panel' });
    await expect(panel.getByTestId('audit-score').first()).toHaveText('80%');
  } finally {
    await asMigrator(`delete from ops.task_step where task_id = $1`, [task!.id]);
    await asMigrator(`delete from ops.task where id = $1`, [task!.id]);
  }
});
