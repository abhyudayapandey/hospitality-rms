import { expect, test } from '@playwright/test';
import { placeId, signInAs } from './helpers';

// The simpler screens (UX-7 to UX-12, ADR 047): one thing first, detail on a tap. These
// check the closed state with { expanded: false }; the other specs open the detail.

test('the GM: Do these first (at most five), then Waiting for you, departments closed', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  const first = page.getByTestId('dofirst-card');
  await expect(first).toBeVisible();
  const n = await first.getByTestId('dofirst-item').count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(5);
  // every line has one action and no summed badge of its own
  await expect(first.getByTestId('dofirst-item').first().getByRole('link')).toHaveCount(1);
  // the department wall is one tap away, closed
  const all = page.getByTestId('attention-card').locator('details');
  await expect(all).toBeVisible();
  await expect(all).not.toHaveAttribute('open', '');
  await expect(page.getByTestId('attention-group').first()).toBeHidden();
  await all.locator('summary').click();
  await expect(page.getByTestId('attention-group').first()).toBeVisible();
});

test('the area manager: outlets side by side as shares of total cost, adding up to 100', async ({
  page,
}) => {
  await signInAs(page, 'Test Area Manager', { expanded: false });
  const card = page.getByTestId('league-card');
  await expect(card).toBeVisible();
  for (const h of ['Food', 'Drinks', 'Losses', 'People']) {
    await expect(card.getByRole('columnheader', { name: h })).toBeVisible();
  }
  await expect(card).toContainText("shares of each outlet's total cost");
  // a row with every share adds up to 100
  const rows = card.locator('tbody tr[data-tone]'); // an outlet's row, not its why (ADR 053)
  const count = await rows.count();
  let checked = 0;
  for (let i = 0; i < count; i++) {
    const cells = await rows.nth(i).locator('td').allInnerTexts();
    const shares = cells.slice(1).map((c) => parseFloat(c.replace('%', '')));
    if (shares.every((v) => Number.isFinite(v))) {
      expect(shares.reduce((a, b) => a + b, 0)).toBeGreaterThan(98);
      expect(shares.reduce((a, b) => a + b, 0)).toBeLessThan(102);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test('Outlet today opens with four headline figures; the rest is under More figures', async ({
  page,
}) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  await page.goto(`/reports/outlet?node=${hotel}`);
  await expect(page.getByTestId('headline').getByRole('listitem')).toHaveCount(4);
  const more = page.getByTestId('more-figures');
  await expect(more).not.toHaveAttribute('open', '');
  await expect(page.getByTestId('measure-stock_value')).toBeHidden();
  await more.locator('summary').click();
  await expect(page.getByTestId('measure-stock_value')).toBeVisible();
  // a term keeps its name and says what it means
  await page.goto(`/reports/cost?node=${hotel}`);
  await page.getByTestId('more-figures').locator('summary').click();
  await expect(page.getByTestId('measure-beyond_tolerance')).toContainText(
    'Items beyond tolerance',
  );
  await expect(page.getByTestId('measure-beyond_tolerance').getByTestId('hint')).toBeVisible();
});

test('Where the money went is a bar; the numbers wait behind a tap', async ({ page }) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  await page.goto(`/reports/cost?node=${hotel}`);
  await expect(page.getByTestId('cost-bar')).toBeVisible();
  await expect(page.getByTestId('share-food')).toBeVisible();
  await expect(page.getByTestId('cost-breakdown')).toBeHidden();
  await page.getByTestId('cost-numbers').locator('summary').click();
  await expect(page.getByTestId('cost-breakdown')).toBeVisible();
});

test('the reports list is grouped by question, with a place to start', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  await page.goto('/reports');
  const list = page.getByTestId('report-list');
  await expect(list.getByRole('heading', { name: 'How are we doing?' })).toBeVisible();
  await expect(list.getByTestId('start-here')).toHaveCount(1);
});

test('Stock position: five at a time, the rest on "Show more", and a search', async ({ page }) => {
  const hotel = await placeId('TEST-HOTEL-1.0');
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  await page.goto(`/reports/stock?node=${hotel}`);
  const dead = page.getByTestId('dead-stock');
  const visible = dead.locator('li:not([hidden])');
  expect(await visible.count()).toBeLessThanOrEqual(5);
  const total = await dead.locator('li').count();
  if (total > 5) {
    await page.getByTestId('show-more').first().click();
    expect(await dead.locator('li:not([hidden])').count()).toBe(total);
  }
});

test('a commis: My shifts leads with the next shift and a week strip', async ({ page }) => {
  await signInAs(page, 'Test Commis B 1.0', { expanded: false });
  await page.goto('/roster/my');
  await expect(page.getByTestId('next-shift')).toBeVisible();
  await expect(page.getByTestId('week-strip').getByRole('listitem')).toHaveCount(7);
  // no "+1": a shift past midnight says when it ends
  await expect(page.getByTestId('my-shifts')).not.toContainText('+1');
});

test('Home offers Clock in only near a shift', async ({ page }) => {
  await signInAs(page, 'Test Commis B 1.0', { expanded: false });
  const card = page.getByTestId('shift-card');
  if ((await card.count()) > 0) {
    const text = (await card.innerText()).toLowerCase();
    const near = text.includes('on shift') || text.includes('not clocked in');
    const clockIn = await card.getByRole('link', { name: /Clock (in|out)/ }).count();
    // a card that offers Clock in is the "not clocked in" kind; "Your next shift" offers none
    expect(clockIn > 0).toBe(near);
  }
});

test('Home opens on the job, with no welcome card to read first', async ({ page }) => {
  await signInAs(page, 'Test Commis B 1.0', { expanded: false });
  await expect(page.getByTestId('tasks-card')).toBeVisible();
  await expect(page.getByText('Welcome', { exact: true })).toHaveCount(0);
});

test('the to-do list has one name in the bar and the heading', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  await page
    .getByRole('link', { name: /^To do list/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'To do list', level: 1 })).toBeVisible();
});

test('tabs wrap instead of running off the screen', async ({ page }) => {
  await signInAs(page, 'Test Store Keeper 1.0', { expanded: false });
  await page.goto('/stock');
  const nav = page.getByRole('navigation', { name: 'Stock tabs' });
  await expect(nav).toBeVisible();
  const box = await nav.boundingBox();
  const last = await nav.getByRole('link').last().boundingBox();
  expect(last!.x + last!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
});

test('a long list can be searched', async ({ page }) => {
  await signInAs(page, 'Test Store Keeper 1.0', { expanded: false });
  await page.goto('/stock');
  const rows = page.getByTestId('stock-row');
  const total = await rows.count();
  test.skip(total <= 8, 'a short list has no search box');
  const first = await rows.first().getAttribute('data-sku');
  await page.getByTestId('list-search').fill(first!);
  await expect(rows.filter({ visible: true })).not.toHaveCount(total);
  await expect(rows.first()).toBeVisible();
});
