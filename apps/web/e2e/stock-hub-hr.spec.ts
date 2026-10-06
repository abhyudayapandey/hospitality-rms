import { expect, test } from '@playwright/test';
import { placeId, signInAs, viewing, viewingOptions } from './helpers';

// UX-4 and UX-5 (ADR 035) through the real screens: the Stock hub, sales entry with search
// and copy, Team → People and Leave, and deactivation through approval. Who may do what
// is proved in packages/db/src/stock-hub-hr.db.test.ts; these check the screens follow it.

test('Stock is a hub: on its way here, count due, then the store jobs', async ({ page }) => {
  await signInAs(page, 'Test Head Cook 3.0');
  await page.goto(`/stock?node=${await placeId('TEST-BAR-3.0-KITCHEN-STORE')}`);
  // file 36's transfer is still in transit
  await expect(page.getByTestId('attention-transit')).toContainText('On its way here');
  const jobs = page.getByRole('navigation', { name: 'Stock jobs' }).getByRole('link');
  await expect(jobs.first()).toHaveText('Count');
  await jobs.filter({ hasText: 'Record wastage' }).click();
  await page.waitForURL(/\/stock\/wastage/);
});

test('a store never counted has a count due', async ({ page }) => {
  // no spec counts this store (inventory.spec counts Bar 3.0's kitchen)
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock?node=${await placeId('TEST-HOTEL-1.0-KITCHEN-STORE')}`);
  await expect(page.getByTestId('attention-count')).toContainText('Never counted here');
});

test('a store counted today has no count due', async ({ page }) => {
  await signInAs(page, 'Test Bar Manager 1.0');
  await page.goto(`/stock?node=${await placeId('TEST-HOTEL-1.0-BAR-STORE')}`);
  await expect(page.getByTestId('stock-row').first()).toBeVisible();
  await expect(page.getByTestId('attention-count')).toHaveCount(0);
});

test('sales entry: find a dish, copy last week, total as you go (nothing saved)', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/menu/sales');
  const total = page.getByTestId('sales-total');
  const copies = page.getByTestId('sales-copy').getByRole('button');
  await expect(copies.first()).toBeVisible();
  await copies.last().click();
  await expect(page.getByRole('status')).toContainText('changed');
  await expect(total).not.toContainText(/\b0 sold/);
  const rows = page.getByRole('spinbutton');
  const all = await rows.count();
  await page.getByLabel('Find a dish or drink').fill('zzzz-nothing');
  await expect(rows).toHaveCount(0);
  await page.getByLabel('Find a dish or drink').fill('');
  await expect(rows).toHaveCount(all);
});

test('Team → People and Leave; deactivation goes to the security admin', async ({ page }) => {
  // the server has neither tab, and the page refuses
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/team/people');
  await expect(page.getByTestId('people')).toHaveCount(0);

  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/team/people');
  const steward = page.getByTestId('person').filter({ hasText: 'Test Steward 1.0' });
  await expect(steward).toBeVisible();
  await steward.getByText('Deactivate', { exact: true }).click();
  await steward.getByLabel('Why deactivate Test Steward 1.0').fill('Left the company');
  await steward.getByRole('button', { name: 'Ask to deactivate Test Steward 1.0' }).click();
  await expect(steward).toContainText('Deactivation waiting');

  await page
    .getByRole('navigation', { name: 'Team', exact: true })
    .getByRole('link', { name: 'Leave' })
    .click();
  await page.waitForURL(/\/team\/leave/);
  await expect(page.getByRole('heading', { name: 'Leave' })).toBeVisible();

  // the security admin sees who and why, and says no (the steward keeps working)
  await signInAs(page, 'Test Security Admin');
  await page.goto('/inbox');
  const item = page
    .getByTestId('inbox-item')
    .filter({ hasText: 'Deactivate Test Steward 1.0: Left the company' });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Reject' }).click();
  await expect(item.getByRole('status')).toBeVisible();
});

test('Home expiry banners open a list with as many items as they count', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0');
  for (const show of ['expiring', 'expired'] as const) {
    await page.goto('/');
    const banner = page.getByTestId(`banner-${show}`);
    if ((await banner.count()) === 0) continue;
    const n = Number((await banner.locator('.tabular-nums').innerText()).trim());
    await banner.click();
    await page.waitForURL(/\/stock\?.*tab=expir/);
    // "All stores" chosen in the Place picker (ADR 038)
    await expect.poll(() => viewing(page)).toBe('All stores');
    await expect(page.getByTestId('expiry-row')).toHaveCount(n);
  }
});

test('the expiry lists: All stores or one store, from the Place picker', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/');
  await page.getByTestId('banner-expiring').click();
  await page.waitForURL(/all=1/);
  const picker = page.getByTestId('place-switcher').getByRole('combobox', { name: 'Place' });
  // the picker may not be on screen the moment the URL changes
  await expect.poll(async () => (await viewingOptions(page))[0]).toBe('All stores');
  const all = await page.getByTestId('expiry-row').count();
  // one store: only its batches, without the store on each line
  await picker.selectOption({ label: 'Kitchen Store' });
  await page.waitForURL((u) => !u.searchParams.has('all'));
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – Kitchen Store');
  await expect(page.getByTestId('expiry-store')).toHaveCount(0);
  await expect(page.locator('[data-sku="GINGER-GARLIC-PASTE"]')).toBeVisible();
  expect(await page.getByTestId('expiry-row').count()).toBeLessThanOrEqual(all);
  // the Expired tab keeps the choice
  await page.getByRole('link', { name: /^Expired/ }).click();
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – Kitchen Store');
  await expect(page.locator('[data-sku="MINT-CHUTNEY"]')).toBeVisible();
  // and back to all of them, each line naming its store
  await picker.selectOption({ label: 'All stores' });
  await page.waitForURL(/all=1/);
  await expect.poll(() => viewing(page)).toBe('All stores');
  await expect(page.getByRole('link', { name: /^Expired/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const rows = await page.getByTestId('expiry-row').count();
  await expect(page.getByTestId('expiry-store')).toHaveCount(rows);
});

test('People report: a department opens the names of the people in it', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/reports/people');
  const kitchen = page.getByTestId('people-department').filter({ hasText: 'Kitchen' }).first();
  const headcount = Number(
    (await kitchen.locator('.tabular-nums').first().innerText()).split(' ')[0],
  );
  await kitchen.getByRole('link').click();
  await page.waitForURL(/\/team\/people\?node=/);
  await expect(page.getByTestId('person').first()).toBeVisible();
  // the department, not the outlet: as many people as the row says
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – Kitchen');
  expect(await page.getByTestId('person').count()).toBe(headcount);
});

test("People report: the outlet's own row opens the people in no department, not everyone", async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/reports/people');
  const own = page.getByTestId('people-department').filter({ hasText: 'Not in a department' });
  const headcount = Number((await own.locator('.tabular-nums').first().innerText()).split(' ')[0]);
  await own.getByRole('link').click();
  await page.waitForURL(/\/team\/people\?node=.*here=1/);
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0');
  await expect(page.getByTestId('person')).toHaveCount(headcount);
  // and everyone at the outlet is one tap away
  await page.getByTestId('people-everyone').click();
  await expect(page.getByTestId('people-count')).not.toContainText('not in a department');
});
