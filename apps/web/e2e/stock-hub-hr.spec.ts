import { expect, test } from '@playwright/test';
import { placeId, signInAs } from './helpers';

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
