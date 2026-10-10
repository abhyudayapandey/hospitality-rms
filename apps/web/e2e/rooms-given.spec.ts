import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Rooms given to attendants (ADR 111) at 380 px on Test Hotel 1.0: the executive housekeeper
// gives rooms 101 and 102 to a room attendant, who sees them first and every other room folded
// under them. Who may give rooms is proved in packages/db/src/rooms-linen.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('the housekeeper gives rooms; the attendant sees theirs first and the rest folded', async ({
  page,
}) => {
  const outlet = await placeId('TEST-HOTEL-1.0');
  try {
    await signInAs(page, 'Test Executive Housekeeper 1.0');
    await page.goto(`/rooms?outlet=${outlet}`);
    await main(page).getByTestId('give-rooms').click();
    await page.waitForURL(/\/rooms\/give/);
    await main(page)
      .getByRole('group', { name: 'Person' })
      .getByRole('button', { name: /Test Room Attendant 1\.0/ })
      .click();
    for (const n of ['101', '102']) {
      await main(page)
        .getByRole('button', { name: `Room ${n}`, exact: true })
        .click();
    }
    await main(page)
      .getByRole('button', { name: /^Give .* 2 rooms$/ })
      .click();
    await expect(main(page).getByRole('status')).toContainText('2 rooms');

    await signInAs(page, 'Test Room Attendant 1.0');
    await page.goto(`/rooms?outlet=${outlet}`);
    const mine = main(page).getByTestId('my-rooms');
    await expect(mine.getByTestId('room')).toHaveCount(2);
    const others = main(page).getByTestId('other-rooms');
    await expect(others).not.toHaveAttribute('open', '');
    await others.locator('summary').click();
    await expect(others.getByTestId('room').first()).toBeVisible();
    // the attendant does not give rooms
    await expect(main(page).getByTestId('give-rooms')).toHaveCount(0);
    await page.goto(`/minibar?outlet=${outlet}&tab=rooms`);
    await expect(main(page).getByTestId('minibar-mine').getByTestId('minibar-room')).toHaveCount(2);
  } finally {
    await asMigrator(`delete from ops.room_assignment where org_node_id = $1`, [outlet]);
  }
});
