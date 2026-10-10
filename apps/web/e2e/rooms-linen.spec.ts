import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Rooms (contents, breakfast) and Linen & uniforms (ADR 094) at 380 px on Test Hotel 1.0. A
// room attendant counts room 101 and is a towel short; front office gives today's breakfast and
// a room, which the executive chef reads; the laundry attendant records the exchange and issues
// a uniform. Who may is proved in packages/db/src/rooms-linen.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('a room is counted; breakfast is given and read', async ({ page }) => {
  const outlet = await placeId('TEST-HOTEL-1.0');
  const started = new Date();
  try {
    await signInAs(page, 'Test Room Attendant 1.0');
    await page.goto(`/rooms?outlet=${outlet}&view=contents`);
    const r101 = main(page).getByTestId('room-contents').filter({ hasText: '101' });
    await r101.getByRole('link', { name: 'Count this room' }).click();
    await page.waitForURL(/\/rooms\/count/);
    for (const [item, n] of [
      ['Test Bath Towel', '1'],
      ['Test Hand Towel', '2'],
      ['Test Bedsheet King', '1'],
      ['Test Pillow Cover', '4'],
      ['Test Shampoo 30ml', '2'],
      ['Test Soap Bar 40g', '2'],
    ] as const) {
      await main(page).getByLabel(item, { exact: true }).fill(n);
    }
    await main(page).getByRole('button', { name: 'Save the count' }).click();
    await page.waitForURL(/view=contents/);
    await expect(
      main(page)
        .getByTestId('room-contents')
        .filter({ hasText: '101' })
        .getByTestId('room-line')
        .filter({ hasText: 'Test Bath Towel' })
        .getByTestId('room-counted'),
    ).toContainText('counted 1 each');

    // breakfast (ADR 110): the next one opens, buffet first, a room is two unless changed
    await signInAs(page, 'Test Front Desk Executive 1.0');
    await page.goto(`/breakfast?outlet=${outlet}`);
    await expect(main(page).getByTestId('breakfast-buffet')).toBeVisible();
    await expect(main(page).locator('section[data-testid^="breakfast-"]').first()).toHaveAttribute(
      'data-testid',
      'breakfast-buffet',
    );
    await main(page).getByRole('textbox', { name: 'Buffet guests' }).fill('18');
    await main(page).getByTestId('breakfast-add-in_room').click();
    await main(page)
      .getByTestId('breakfast-add')
      .getByRole('group', { name: 'Room' })
      .getByRole('button', { name: 'Room 102' })
      .click();
    await main(page).getByLabel('Note for the kitchen (optional)').fill('no onion');
    await main(page).getByRole('button', { name: 'Add room 102 · 2 guests' }).click();
    await expect(main(page).getByRole('textbox', { name: 'In-room guests' })).toHaveValue('2');
    await main(page)
      .getByRole('button', { name: /^Save / })
      .click();
    await expect(main(page).getByRole('status')).toHaveText('Saved.');
    // the next day starts from its own numbers, never this one's
    const dayLinks = main(page)
      .getByRole('navigation', { name: 'Day' })
      .getByTestId('breakfast-day');
    await dayLinks.last().click();
    await page.waitForURL(/day=/);
    await expect(main(page).getByRole('textbox', { name: 'Buffet guests' })).toHaveValue('');

    await signInAs(page, 'Test Executive Chef 1.0');
    await page.goto(`/breakfast?outlet=${outlet}`);
    await expect(
      main(page).getByTestId('breakfast-in_room').getByTestId('breakfast-total'),
    ).toContainText('2 guests · 2 by room');
    await expect(
      main(page).getByTestId('breakfast-buffet').getByTestId('breakfast-total'),
    ).toContainText('18 guests');
    await expect(main(page).getByTestId('breakfast-room')).toContainText('no onion');
    await expect(main(page).getByRole('button', { name: /^Save / })).toHaveCount(0);
  } finally {
    await asMigrator(`delete from ops.room_count where org_node_id = $1 and created_at >= $2`, [
      outlet,
      started,
    ]);
    await asMigrator(`delete from ops.breakfast_room where org_node_id = $1`, [outlet]);
    await asMigrator(`delete from ops.breakfast where org_node_id = $1`, [outlet]);
  }
});

test('the laundry exchange and a uniform', async ({ page }) => {
  const hk = await placeId('TEST-HOTEL-1.0-HOUSEKEEPING');
  try {
    await signInAs(page, 'Test Laundry Attendant 1.0');
    await page.goto(`/linen?place=${hk}`);
    await main(page).getByLabel('Test Bath Towel sent').fill('30');
    await main(page).getByLabel('Test Bath Towel back').fill('12');
    await main(page).getByRole('button', { name: "Save today's exchange" }).click();
    await expect(
      main(page).getByTestId('at-laundry').filter({ hasText: 'Test Bath Towel' }),
    ).toContainText('18');

    await main(page).getByRole('link', { name: 'Uniforms' }).click();
    await page.waitForURL(/view=uniforms/);
    await main(page)
      .getByRole('combobox', { name: /^To/ })
      .selectOption({ label: 'Test Room Attendant B 1.0' });
    await main(page).getByLabel('What').fill('Housekeeping tunic');
    await main(page).getByLabel('Size').fill('M');
    await main(page).getByLabel('How many').fill('2');
    await main(page).getByRole('button', { name: 'Issue' }).click();
    const issued = main(page).getByTestId('uniform').filter({ hasText: 'Housekeeping tunic' });
    await expect(issued).toContainText('Test Room Attendant B 1.0');
    await issued.getByRole('button', { name: 'Returned' }).click();
    await expect(issued).toContainText('returned');
  } finally {
    await asMigrator(`delete from ops.laundry_exchange where org_node_id = $1`, [hk]);
    await asMigrator(`delete from ops.uniform_issue where org_node_id = $1`, [hk]);
  }
});
