import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// What the Passport demo walk found (ADR 097), at 380 px on Test Hotel 1.0: the Breakfast tile
// only for those who keep or read a hotel's breakfast; a commis opens a pack from their own
// screen; Back from an SOP returns to where the list was opened from; the laundry form keeps each
// item's name whole and its numbers inside the screen.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('the Breakfast tile: front office and a hotel kitchen, not engineering or a bar kitchen', async ({
  page,
}) => {
  for (const [who, shown] of [
    ['Test Front Office Manager 1.0', true],
    ['Test Commis 1.0', true],
    ['Test Technician 1.0', false],
    ['Test Commis 3.0', false],
  ] as const) {
    await signInAs(page, who);
    await page.goto('/me');
    await expect(page.getByTestId('me-profile')).toBeVisible();
    await expect(page.getByTestId('me-breakfast'), who).toHaveCount(shown ? 1 : 0);
  }
});

test('a commis opens a pack of milk from their own Opened packs screen', async ({ page }) => {
  const store = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  const started = new Date();
  try {
    await signInAs(page, 'Test Commis 1.0');
    await page.goto('/me');
    await page.getByTestId('me-opened').click();
    await page.waitForURL(/\/stock\/opened/);
    await main(page).getByLabel('What you opened').selectOption({ label: 'Test Milk (l)' });
    await main(page)
      .getByLabel(/^How much/)
      .fill('1');
    await main(page).getByRole('button', { name: 'Open and print the label' }).click();
    await page.waitForURL(/\/stock\/opened\/label\//);
    await expect(page.getByTestId('label-opened-by')).toHaveText('Test Commis 1.0');
  } finally {
    await asMigrator(
      `delete from inv.opened_pack where delivery_node_id = $1 and created_at >= $2`,
      [store, started],
    );
  }
});

test("a store's Opened tab shows only where something has a shelf life once opened", async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  const hk = await placeId('TEST-HOTEL-1.0-HOUSEKEEPING-STORE');
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto(`/stock?node=${hk}`);
  await expect(main(page).getByRole('link', { name: 'Stock', exact: true })).toBeVisible();
  await expect(main(page).getByRole('link', { name: 'Opened', exact: true })).toHaveCount(0);
  // an item with a shelf life once opened is opened from its page
  await page.goto(`/stock?node=${kitchen}`);
  await main(page)
    .getByRole('link', { name: /Test Milk/ })
    .first()
    .click();
  await main(page).getByTestId('open-a-pack').click();
  await page.waitForURL(/\/stock\/opened\?.*item=/);
  await expect(main(page).getByLabel('What you opened')).toHaveValue(/[0-9a-f-]{36}/);
});

test('Back from an SOP goes back to the list, and Back from there leaves it', async ({ page }) => {
  await signInAs(page, 'Test Commis 1.0');
  await page.goto('/me');
  await page.goto('/me/sops');
  await main(page).getByTestId('my-sop').filter({ hasText: 'Handwashing' }).click();
  await expect(main(page).getByTestId('sop-body')).toBeVisible();
  await main(page).getByRole('link', { name: '← Back' }).click();
  await page.waitForURL(/\/me\/sops$/);
  await main(page).getByRole('link', { name: '← Back' }).click();
  await page.waitForURL(/\/me$/);
});

test('the laundry form keeps each name whole and its numbers inside the screen', async ({
  page,
}) => {
  const hk = await placeId('TEST-HOTEL-1.0-HOUSEKEEPING');
  await signInAs(page, 'Test Laundry Attendant 1.0');
  await page.goto(`/linen?place=${hk}`);
  const lines = main(page).getByTestId('laundry-line');
  await expect(lines.first()).toBeVisible();
  for (const line of await lines.all()) {
    for (const input of await line.locator('input').all()) {
      const box = (await input.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(380);
      expect(box.width).toBeGreaterThanOrEqual(100);
    }
  }
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(380);
});

test("a department head's roster opens by person; the GM's by shift", async ({ page }) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/roster/week?node=${kitchen}`);
  await expect(page.getByTestId('view-people')).toHaveText('By shift');
  await expect(page.getByTestId('person-row').first()).toBeVisible();
  // no kitchen shift type is the executive chef's: Off, and a line saying so, not the other
  // roles' tiles a tap would be refused (ADR 097)
  const chef = page.getByTestId('person-row').filter({ hasText: 'Test Executive Chef 1.0' });
  await expect(chef.getByTestId('no-shift-types')).toBeVisible();
  await expect(chef.getByTestId('shift-tile')).toHaveCount(1);
  await expect(chef.getByTestId('shift-tile')).toHaveAttribute('data-type', 'off');

  await signInAs(page, 'Test General Manager 1.0');
  await page.goto(`/roster/week?node=${kitchen}`);
  await expect(page.getByTestId('view-people')).toHaveText('By person');
});

test('a shift added by hand shows as theirs on the roster by person, not as Off', async ({
  page,
}) => {
  const restaurant = await placeId('TEST-HOTEL-1.0-RESTAURANT');
  const [{ day = '' } = {}] = await asMigrator<{ day: string }>(
    `select (date_trunc('week', now() at time zone 'Asia/Kolkata')::date + 37)::text as day`,
    [],
  );
  const [shift] = await asMigrator<{ id: string }>(
    `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code,
                           headcount)
     select n.tenant_id, n.id, $2::date, ($2::date + time '12:00') at time zone 'Asia/Kolkata',
            ($2::date + time '16:00') at time zone 'Asia/Kolkata', 'STEWARD', 1
       from core.hierarchy_node n where n.id = $1
     returning id`,
    [restaurant, day],
  );
  await asMigrator(
    `insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                      start_at, end_at)
     select s.tenant_id, s.id, w.id, w.owner_user_id, s.org_node_id, s.start_at, s.end_at
       from hr.shift s, hr.worker w join core.app_user u on u.id = w.owner_user_id
      where s.id = $1 and u.username = 'test.steward-c.1.0'`,
    [shift!.id],
  );
  try {
    await signInAs(page, 'Test Restaurant Manager 1.0');
    await page.goto(`/roster/week?node=${restaurant}&week=${day}&day=${day}&view=people`);
    const row = page.getByTestId('person-row').filter({ hasText: 'Test Steward C 1.0' });
    const mine = row.locator('[data-type="other"]');
    await expect(mine).toContainText('12:00–16:00');
    await expect(row.locator('[data-type="off"]')).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await asMigrator(`delete from hr.shift_assignment where shift_id = $1`, [shift!.id]);
    await asMigrator(`delete from hr.shift where id = $1`, [shift!.id]);
  }
});
