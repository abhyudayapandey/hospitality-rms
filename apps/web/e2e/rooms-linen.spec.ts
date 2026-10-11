import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Rooms (contents, breakfast) and Linen & uniforms (ADR 094) at 380 px on Test Hotel 1.0. A
// room attendant counts room 101 and is a towel short; the restaurant gives the next breakfast
// by room, which the executive chef and the front desk read (ADR 121); the laundry attendant records the exchange and issues
// a uniform. Who may is proved in packages/db/src/rooms-linen.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('a room is counted; breakfast is given by room and read', async ({ page }) => {
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

    // meals (ADR 110, 121): the next breakfast opens, buffet first; the restaurant adds rooms
    // as tiles, each with its guests inside, and saves
    await signInAs(page, 'Test Steward 1.0');
    await page.goto(`/breakfast?outlet=${outlet}`);
    await expect(main(page).getByTestId('breakfast-buffet')).toBeVisible();
    await expect(main(page).locator('section[data-testid^="breakfast-"]').first()).toHaveAttribute(
      'data-testid',
      'breakfast-buffet',
    );
    await main(page).getByTestId('breakfast-add-buffet').click();
    const picker = main(page).getByTestId('breakfast-add');
    await picker.getByRole('button', { name: 'Room 101' }).click();
    await picker.getByRole('button', { name: 'Room 201' }).click();
    await picker.getByRole('button', { name: 'One more in room 201' }).click();
    await picker.getByTestId('breakfast-picked').click();
    await expect(
      main(page).getByTestId('breakfast-buffet').getByTestId('breakfast-by-room'),
    ).toHaveText('3 guests in 2 rooms');
    await main(page).getByTestId('breakfast-add-in_room').click();
    await expect(picker.getByRole('button', { name: 'Room 101' })).toHaveCount(0);
    await picker.getByRole('button', { name: 'Room 102' }).click();
    await picker.getByTestId('breakfast-picked').click();
    await main(page)
      .getByRole('button', { name: /^Save / })
      .click();
    await expect(main(page).getByRole('status')).toHaveText('Saved.');
    // the next day starts from its own rooms, never this one's
    const dayLinks = main(page)
      .getByRole('navigation', { name: 'Day' })
      .getByTestId('breakfast-day');
    await dayLinks.last().click();
    await page.waitForURL(/day=/);
    await expect(main(page).getByTestId('breakfast-room')).toHaveCount(0);
    // lunch is its own meal; another day is never a later one
    await main(page).getByRole('link', { name: 'Lunch' }).click();
    await page.waitForURL(/meal=lunch/);
    await expect(main(page).getByTestId('breakfast-buffet')).toContainText('Restaurant');
    await main(page).getByTestId('breakfast-other-day').click();
    await expect(main(page).getByRole('textbox', { name: 'Day' })).toHaveAttribute('max', /\d{4}-/);

    // the kitchen reads it and changes nothing; the front desk too
    for (const who of ['Test Executive Chef 1.0', 'Test Front Desk Executive 1.0']) {
      await signInAs(page, who);
      await page.goto(`/breakfast?outlet=${outlet}`);
      await expect(
        main(page).getByTestId('breakfast-buffet').getByTestId('breakfast-total'),
      ).toContainText('3 guests · 2 rooms');
      await expect(
        main(page).getByTestId('breakfast-in_room').getByTestId('breakfast-total'),
      ).toContainText('1 guest · 1 room');
      await expect(main(page).getByRole('button', { name: /^Save / })).toHaveCount(0);
    }
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
    // sending and taking back are two moments (ADR 113): Send asks only for what goes out
    await main(page).getByLabel('Test Bath Towel sent').fill('30');
    await main(page).getByRole('button', { name: 'Save what went out' }).click();
    await main(page).getByRole('link', { name: 'Receive (1 out)' }).click();
    await page.waitForURL(/view=receive/);
    const towel = main(page).getByTestId('receive-line').filter({ hasText: 'Test Bath Towel' });
    await expect(towel).toContainText('30 out');
    await main(page).getByLabel('Test Bath Towel back').fill('12');
    await expect(towel.getByTestId('receive-short')).toHaveText('18 short');
    await main(page).getByRole('button', { name: 'Save what came back' }).click();
    await expect(towel).toContainText('18 out');

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
