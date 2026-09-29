import { expect, test, type Page } from '@playwright/test';
import { NODE, runExecutor, signInAs } from './helpers';

async function onHand(page: Page, sku: string, node: string): Promise<number> {
  await page.goto(`/stock?node=${node}`);
  const text = await page.locator(`[data-sku="${sku}"] [data-testid="on-hand"]`).textContent();
  return parseFloat(text!.replace(/,/g, ''));
}

test('two-leg transfer: requested, sent by the hub, received short at the outlet', async ({
  page,
}) => {
  await signInAs(page, 'Kim Storekeeper');
  const before = await onHand(page, 'VEG-POTATO', NODE.outletA);

  await page.goto(`/stock/transfers/new?node=${NODE.outletA}`);
  await expect(page.getByRole('combobox', { name: 'From' })).toHaveValue(NODE.hub);
  await page.getByRole('textbox', { name: 'Request Potatoes' }).fill('4');
  await page.getByRole('button', { name: 'Request 1 items' }).click();
  await page.waitForURL(/\/stock\/transfers\/[0-9a-f-]{36}/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByTestId('transfer-progress')).toHaveText('awaiting dispatch');

  await signInAs(page, 'Hugo Hub Manager');
  await page.goto('/inbox');
  await page.locator(`a[href^="/stock/transfers/${id}"]`).click();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0); // module only
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText('Sent. It is now in transit.');
  await expect(page.getByTestId('transfer-progress')).toHaveText('in transit');

  await signInAs(page, 'Olivia Outlet Manager');
  await page.goto('/inbox');
  await page.locator(`a[href^="/stock/transfers/${id}"]`).click();
  await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0); // in transit
  await page.getByRole('textbox', { name: 'Received Potatoes' }).fill('3.5');
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(page.getByRole('status')).toHaveText('Received.');

  await runExecutor(); // inv.transfer.post completes it
  await page.reload();
  await expect(page.getByTestId('transfer-progress')).toHaveText('received');
  // +4 in, -0.5 transit loss
  expect(await onHand(page, 'VEG-POTATO', NODE.outletA)).toBeCloseTo(before + 3.5, 3);
});

test('a count within tolerance posts straight away', async ({ page }) => {
  await signInAs(page, 'Kim Storekeeper');
  const before = await onHand(page, 'DRY-SALT', NODE.outletA);

  await page.goto(`/stock/count?node=${NODE.outletA}`);
  const resume = page.getByRole('link', { name: /^Continue the count/ });
  if (await resume.count()) await resume.click();
  else await page.getByRole('button', { name: 'Start a count' }).click();
  await page.waitForURL(/\/stock\/count\/[0-9a-f-]{36}/);
  await page.getByRole('textbox', { name: 'Counted Iodised salt' }).fill(String(before - 0.5));
  await page.getByRole('button', { name: /^Submit count/ }).click();
  await expect(page.getByRole('status')).toContainText('1 posted, 0 sent for approval');

  expect(await onHand(page, 'DRY-SALT', NODE.outletA)).toBeCloseTo(before - 0.5, 3);
});

test('the area manager sees outlet stock read-only (derived view)', async ({ page }) => {
  await signInAs(page, 'Aria Area Manager');
  await page.goto(`/stock?node=${NODE.outletA}`);
  await expect(page.getByTestId('supply-node')).toHaveText('Outlet A (view only)');
  await expect(page.getByTestId('stock-row').first()).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Supply' });
  await expect(tabs.getByRole('link', { name: 'Stock' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Count' })).toHaveCount(0);
  await expect(tabs.getByRole('link', { name: 'Wastage' })).toHaveCount(0);
  await page.goto(`/stock/orders?node=${NODE.outletA}`);
  await expect(page.getByRole('link', { name: 'New order' })).toHaveCount(0);
});
