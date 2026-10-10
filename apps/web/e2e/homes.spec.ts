import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

async function userId(username: string): Promise<string> {
  const [u] = await asMigrator<{ id: string }>(`select id from core.app_user where username = $1`, [
    username,
  ]);
  return u!.id;
}

// Homes that show the job, once (ADR 113) at 380 px on Test Hotel 1.0: an attendant's Home is
// their rooms; the executive housekeeper's has the room board and Give rooms; a commis's tiles
// are their own work, then Shifts & leave and Report a problem; a shift lead has the frontline
// Home. What each card reads is checked in the database tests (homes, rooms-linen).

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test("an attendant's Home is the rooms given to them today", async ({ page }) => {
  const outlet = await placeId('TEST-HOTEL-1.0');
  const attendant = await userId('test.room-attendant.1.0');
  try {
    await asMigrator(
      `insert into ops.room_assignment (tenant_id, org_node_id, day, room_id, user_id)
       select r.tenant_id, r.org_node_id, rpt.today(r.org_node_id), r.id, $2
         from ops.room r where r.org_node_id = $1 and r.number in ('101', '102')`,
      [outlet, attendant],
    );
    await signInAs(page, 'Test Room Attendant 1.0');
    const rooms = main(page).getByTestId('home-rooms');
    await expect(rooms).toContainText('Your rooms (2)');
    await expect(rooms.getByTestId('room')).toHaveCount(2);
    // the rest is one tap away, never hidden
    await expect(rooms.getByRole('link', { name: 'All rooms' })).toBeVisible();
    // no "My tasks" tile: Tasks is a tab
    await expect(main(page).getByTestId('tile-tasks')).toHaveCount(0);
  } finally {
    await asMigrator(`delete from ops.room_assignment where org_node_id = $1 and user_id = $2`, [
      outlet,
      attendant,
    ]);
  }
});

test("the executive housekeeper's Home has the room board and Give rooms", async ({ page }) => {
  await signInAs(page, 'Test Executive Housekeeper 1.0');
  const rooms = main(page).getByTestId('home-rooms');
  await expect(rooms).toContainText('Rooms now');
  await expect(rooms.getByTestId('room-counts')).toBeVisible();
  await expect(rooms.getByTestId('home-give-rooms')).toBeVisible();
});

test("a commis's tiles are their own work, then Shifts & leave", async ({ page }) => {
  await signInAs(page, 'Test Commis 1.0');
  const tiles = main(page).getByTestId('tiles').first().getByRole('link');
  await expect(tiles.first()).toBeVisible();
  const names = await tiles.allInnerTexts();
  expect(names.join(' | ')).toMatch(/Make/);
  expect(names.join(' | ')).toMatch(/Shifts & leave/);
  expect(names.join(' | ')).not.toMatch(/My tasks/);
});

test('a shift lead has the frontline Home: no department tiles, Tasks in the nav', async ({
  page,
}) => {
  await signInAs(page, 'Test Bell Captain 1.0');
  await expect(main(page).getByTestId('attention-card')).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks' }),
  ).toBeVisible();
});

test('Me: one Shifts & leave tile; Clock and Leave are its tabs', async ({ page }) => {
  await signInAs(page, 'Test Bartender 1.0');
  await page.goto('/me');
  await expect(page.getByTestId('me-shifts')).toHaveText(/Shifts & leave/);
  await expect(page.getByTestId('me-clock')).toHaveCount(0);
  await expect(page.getByTestId('me-leave')).toHaveCount(0);
  await page.getByTestId('me-shifts').click();
  await page.waitForURL(/\/roster\/my/);
  await expect(main(page).getByRole('heading', { name: 'Shifts & leave' })).toBeVisible();
  await expect(main(page).getByTestId('ask-leave')).toBeVisible();
});
