import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Logbook & handover (ADR 089) at 380 px on Test Hotel 1.0's restaurant. A steward hands over
// to a colleague, who reads it on her To do list and acknowledges it; the logbook says so. The
// restaurant manager writes a log for the day and takes it down. Who may is proved in
// packages/db/src/logbook.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('a handover is acknowledged; a log holds until taken down', async ({ page }) => {
  const restaurant = await placeId('TEST-HOTEL-1.0-RESTAURANT');
  const note = `Table 4 owes two coffees ${Date.now()}`;
  const log = `Lift 2 out of order ${Date.now()}`;
  try {
    await signInAs(page, 'Test Steward 1.0');
    await page.goto(`/logbook?place=${restaurant}`);
    await main(page).getByLabel('What they need to know').fill(note);
    await main(page).getByLabel('For').selectOption({ label: 'Test Steward B 1.0' });
    await main(page).getByRole('button', { name: 'Hand over' }).click();
    const entry = main(page).getByTestId('handover').filter({ hasText: note });
    await expect(entry).toContainText('You,');
    await expect(entry.getByTestId('handover-ack')).toHaveText('Not acknowledged yet');

    await signInAs(page, 'Test Steward B 1.0');
    await page.goto('/tasks');
    await main(page)
      .getByRole('link', { name: new RegExp(note) })
      .first()
      .click();
    await expect(page.getByTestId('handover-from')).toContainText('From Test Steward 1.0');
    await main(page).getByRole('button', { name: "I've read it" }).click();
    await expect(page.getByTestId('task-status')).toHaveText(/^Done/);

    await signInAs(page, 'Test Steward 1.0');
    await page.goto(`/logbook?place=${restaurant}`);
    await expect(
      main(page).getByTestId('handover').filter({ hasText: note }).getByTestId('handover-ack'),
    ).toContainText('Acknowledged by Test Steward B 1.0');

    await signInAs(page, 'Test Restaurant Manager 1.0');
    await page.goto(`/logbook?place=${restaurant}`);
    await main(page).getByText('Log', { exact: true }).click();
    await main(page).getByLabel('The log').fill(log);
    await main(page).getByRole('button', { name: 'Save the log' }).click();
    const kept = main(page).getByTestId('log').filter({ hasText: log });
    await expect(kept).toContainText('until');
    await kept.getByRole('button', { name: 'Take it down' }).click();
    await expect(main(page).getByTestId('log').filter({ hasText: log })).toHaveCount(0);
  } finally {
    await asMigrator(
      `with e as (select task_id from ops.log_entry where body in ($1, $2))
       delete from ops.notification where link in (select '/tasks/' || task_id from e)`,
      [note, log],
    );
    await asMigrator(`delete from ops.log_entry where body in ($1, $2) returning task_id`, [
      note,
      log,
    ]);
    await asMigrator(`delete from ops.task where kind = 'handover' and description = $1`, [note]);
  }
});
