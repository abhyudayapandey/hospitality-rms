import { expect, test } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Changes to a published week wait for Publish (ADR 135): Off on a published day is counted in
// Publish (N), the row says "Not published", and Start again puts the published day back. Who
// is told what, and when, is proved in packages/db/src/roster-tiles.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

test('Off on a published day counts in Publish; Start again puts it back', async ({ page }) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN');
  const [{ day = '' } = {}] = await asMigrator<{ day: string }>(
    `select (date_trunc('week', now() at time zone 'Asia/Kolkata')::date + 44)::text as day`,
    [],
  );
  try {
    await signInAs(page, 'Test Executive Chef 1.0');
    await page.goto(`/roster/week?node=${kitchen}&week=${day}&day=${day}&view=people`);
    const row = page.getByTestId('person-row').filter({ hasText: 'Test Executive Chef 1.0' });
    const tile = row.locator('[data-testid="shift-tile"][data-type="straight"]').first();
    const off = row.locator('[data-type="off"]');
    const publish = page.getByRole('button', { name: /^Publish/ });
    await tile.click();
    await expect(publish).toHaveText('Publish (1)');
    await publish.click();
    await expect(page.getByRole('status')).toContainText('Published 1 change.');
    await expect(publish).toBeDisabled();
    await expect(row.getByTestId('not-published')).toHaveCount(0);

    // Off is a change too: counted, marked, and nobody told yet
    await off.click();
    await expect(off).toHaveAttribute('aria-pressed', 'true');
    await expect(row.getByTestId('not-published')).toBeVisible();
    await expect(publish).toHaveText('Publish (1)');

    // Start again: the published day comes back
    await page.getByRole('button', { name: 'Start again' }).click();
    await page
      .getByRole('group', { name: 'Start again' })
      .getByRole('button', { name: 'Undo changes' })
      .click();
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    await expect(row.getByTestId('not-published')).toHaveCount(0);
    await expect(publish).toBeDisabled();

    // Off again, then Publish: they are off
    await off.click();
    await publish.click();
    await expect(page.getByRole('status')).toContainText('Published 1 change.');
    await expect(off).toHaveAttribute('aria-pressed', 'true');
    await expect(row.getByTestId('not-published')).toHaveCount(0);
  } finally {
    await asMigrator(
      `with s as (update hr.shift set status = 'cancelled'
                   where org_node_id = $1 and local_date = $2::date returning id)
       update hr.shift_assignment set status = 'dropped', drop_reason = 'shift_cancelled',
              coming_off = false
        where shift_id in (select id from s) and status in ('assigned', 'pending')`,
      [kitchen, day],
    );
  }
});
