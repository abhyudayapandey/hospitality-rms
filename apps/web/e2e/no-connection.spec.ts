import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// A tap that does not get an answer (ADR 169): the screen says "No connection. Try again."
// where the person is, keeps what they typed, and the next tap sends the same request again,
// so a handover that did reach the server is not written twice.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('a lost answer keeps the typed handover, and trying again writes it once', async ({
  page,
}) => {
  const restaurant = await placeId('TEST-HOTEL-1.0-RESTAURANT');
  const note = `Table 9 left a coat ${Date.now()}`;
  try {
    await signInAs(page, 'Test Steward 1.0');
    await page.goto(`/logbook?place=${restaurant}`);
    await main(page).getByLabel('What they need to know').fill(note);
    await main(page).getByLabel('For').selectOption({ label: 'Test Steward B 1.0' });

    // the request reaches the server, but its answer never comes back
    await page.route('**/logbook**', async (route) => {
      if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) {
        return route.fallback();
      }
      await route.fetch();
      await route.abort('internetdisconnected');
    });
    await main(page).getByRole('button', { name: 'Hand over' }).click();
    await expect(main(page).getByRole('alert')).toHaveText('No connection. Try again.');
    await expect(main(page).getByLabel('What they need to know')).toHaveValue(note);

    await page.unrouteAll({ behavior: 'wait' });
    await main(page).getByRole('button', { name: 'Hand over' }).click();
    await expect(main(page).getByTestId('handover').filter({ hasText: note })).toHaveCount(1);
    const rows = await asMigrator<{ n: number }>(
      'select count(*)::int as n from ops.log_entry where body = $1',
      [note],
    );
    expect(rows[0]!.n).toBe(1);
  } finally {
    await asMigrator(
      `with e as (select task_id from ops.log_entry where body = $1)
       delete from ops.notification where link in (select '/tasks/' || task_id from e)`,
      [note],
    );
    await asMigrator('delete from ops.log_entry where body = $1', [note]);
    await asMigrator(`delete from ops.task where kind = 'handover' and description = $1`, [note]);
  }
});
