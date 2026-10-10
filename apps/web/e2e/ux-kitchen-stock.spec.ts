import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// The kitchen, bar and stores screens after the UX audit (ADR 100 to 102), at 380 px on the test
// customers: a picture on every item line, a recipe's method with pictures and a timer, supply
// requests short items first, the stock check by shelf with status icons, "Count needed" for
// whoever may not correct a figure below zero, the store's jobs kept in reach, and opened packs
// by whole packs. Who may is proved in the DB tests.

test.use({ viewport: { width: 380, height: 800 } });

const main = (page: Page) => page.locator('main');

/** Each row's picture key (null where a row has none). */
const pictures = (page: Page, row: string) =>
  main(page)
    .getByTestId(row)
    .evaluateAll((rows) =>
      rows.map(
        (r) =>
          r.querySelector('[data-testid="item-picture"]')?.getAttribute('data-picture') ?? null,
      ),
    );

test('every stock check row and excise line shows a picture; the check goes by shelf with icons', async ({
  page,
}) => {
  const bar3 = await placeId('TEST-BAR-3.0-BAR-STORE');
  await signInAs(page, 'Test Bar Manager 3.0');
  await page.goto(`/stock/check?node=${bar3}`);
  const rows = main(page)
    .locator('li')
    .filter({ has: page.getByTestId('item-picture') });
  await expect(rows.first()).toBeVisible();
  const shelves = main(page).getByTestId('check-shelf');
  // file 11 gives Bar 3.0's bar store its shelves (ADR 043)
  expect(await shelves.count()).toBeGreaterThan(1);
  await expect(shelves.first().getByRole('heading')).toBeVisible();
  const lis = await main(page).getByTestId('check-shelf').locator('li').count();
  expect(lis).toBeGreaterThan(0);
  expect(await rows.count()).toBe(lis);
  // an icon, not the words, on every row
  await expect(main(page).getByText('Not verified', { exact: true })).toHaveCount(0);
  expect(
    (await main(page).getByRole('img', { name: 'Not verified', exact: true }).count()) +
      (await main(page).getByRole('img', { name: 'Verified', exact: true }).count()),
  ).toBe(lis);

  const bar1 = await placeId('TEST-HOTEL-1.0-BAR-STORE');
  await signInAs(page, 'Test Bar Manager 1.0');
  await page.goto(`/excise?node=${bar1}`);
  await expect(main(page).getByTestId('excise-line').first()).toBeVisible();
  const excise = await pictures(page, 'excise-line');
  expect(excise.length).toBeGreaterThan(0);
  expect(excise).not.toContain(null);
});

test("a recipe's method: a picture of each step, its ingredients' photos and a timer", async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/menu/recipes');
  await page.locator('[data-code="BUTTER-CHICKEN"] a').click();
  await page.getByTestId('sub-recipe').filter({ hasText: 'Makhani Gravy' }).click();
  await expect(page.getByTestId('recipe-name')).toHaveText('Makhani Gravy');
  // "Blanch, peel and roughly chop the tomatoes." (15 min)
  const first = main(page).getByTestId('step').first();
  await expect(first.getByTestId('step-picture')).toHaveAttribute('data-icon', 'pot');
  await expect(first.getByTestId('step-ingredients')).toContainText('Test Tomatoes');
  const timer = first.getByTestId('step-timer');
  await expect(timer).toHaveText('Start 15 min timer');
  await timer.click();
  await expect(first.getByRole('timer')).toContainText(/1[45]:\d\d/);
  await first.getByRole('button', { name: 'Stop' }).click();
  await expect(first.getByTestId('step-timer')).toBeVisible();
  // every step has its picture
  const steps = main(page).getByTestId('step');
  await expect(steps.getByTestId('step-picture')).toHaveCount(await steps.count());
});

test('asking for supplies: short items first, the rest by category, − and +', async ({ page }) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock/orders/new?node=${kitchen}`);
  const sections = main(page).locator('section[data-filter-group]');
  await expect(sections.first()).toBeVisible();
  const headings = await sections.locator('h2').allTextContents();
  const short = main(page).getByTestId('order-short');
  if ((await short.count()) > 0) {
    expect(headings[0]).toBe('Running short');
    await expect(main(page).getByTestId('fill-to-keep')).toBeVisible();
  }
  expect(headings.filter((h) => h !== 'Running short').length).toBeGreaterThan(1);
  // nothing filled in; + on an empty box gives a number
  for (const input of await main(page)
    .getByRole('textbox', { name: /^Quantity / })
    .all()) {
    await expect(input).toHaveValue('');
  }
  const onions = main(page).getByTestId('order-line').filter({ hasText: 'Test Onions' });
  await onions.getByRole('button', { name: 'More' }).click();
  await expect(onions.getByRole('textbox', { name: 'Quantity Test Onions' })).not.toHaveValue('');
  // the search box hides whole categories with nothing left
  await main(page).getByTestId('list-search').fill('Test Onions');
  await expect(main(page).getByTestId('order-line').filter({ visible: true })).toHaveCount(1);
});

test('below zero: "Count needed" for those who may not correct it, the figure for those who may', async ({
  page,
}) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  // the test data's maida is sold below zero at the Hotel 1.0 Kitchen Store (file 27)
  const sku = 'REFINED-FLOUR-MAIDA';
  await signInAs(page, 'Test Area Manager');
  await page.goto(`/stock?node=${kitchen}`);
  const row = main(page).locator(`[data-sku="${sku}"]`);
  await expect(row.getByTestId('count-needed')).toHaveText('Count needed');
  await expect(row.getByTestId('on-hand')).toHaveCount(0);

  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock?node=${kitchen}`);
  const mine = main(page).locator(`[data-sku="${sku}"]`);
  await expect(mine.getByTestId('on-hand')).toHaveText(/^-[\d.]+ kg$/);
  await expect(mine.getByTestId('below-zero')).toBeVisible();
  await expect(mine.getByTestId('count-needed')).toHaveCount(0);
});

test("a long Stock list keeps the store's jobs above the nav", async ({ page }) => {
  const store = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock?node=${store}`);
  const jobs = page.getByRole('navigation', { name: 'Stock jobs' });
  await expect(main(page).getByTestId('stock-row').last()).not.toBeInViewport();
  await expect(jobs).toBeInViewport();
  const nav = page.getByRole('navigation', { name: 'Main' });
  const [j, n] = [(await jobs.boundingBox())!, (await nav.boundingBox())!];
  expect(j.y + j.height).toBeLessThanOrEqual(n.y + 1);
});

test('a commis opens two cartons of cream: by whole packs, and the label says so', async ({
  page,
}) => {
  const store = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  const started = new Date();
  try {
    await signInAs(page, 'Test Commis 1.0');
    await page.goto(`/stock/opened?node=${store}`);
    await main(page)
      .getByRole('group', { name: 'What you opened' })
      .getByRole('button', { name: 'Test Fresh Cream', exact: true })
      .click();
    await expect(main(page).getByTestId('pack-size')).toHaveText('1 carton = 200 ml');
    const many = main(page).getByLabel('How many Test Fresh Cream');
    await expect(many).toHaveValue('1');
    await main(page).getByTestId('pack-count').getByRole('button', { name: 'More' }).click();
    await expect(many).toHaveValue('2');
    await main(page).getByRole('button', { name: 'Open and print the label' }).click();
    await page.waitForURL(/\/stock\/opened\/label\//);
    await expect(page.getByTestId('label-qty')).toHaveText('2 cartons · 400 ml');
  } finally {
    await asMigrator(
      `delete from inv.opened_pack where delivery_node_id = $1 and created_at >= $2`,
      [store, started],
    );
  }
});
