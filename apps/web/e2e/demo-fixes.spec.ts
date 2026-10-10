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

  await signInAs(page, 'Test General Manager 1.0');
  await page.goto(`/roster/week?node=${kitchen}`);
  await expect(page.getByTestId('view-people')).toHaveText('By person');
});
