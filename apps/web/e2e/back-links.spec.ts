import { expect, test } from '@playwright/test';
import { signInAs } from './helpers';

// "← Back" from an item returns to the Stock list as it was: its tab and All stores (ADR 053,
// 169), not the store's first tab.

test('back from an item keeps the Stock tab and All stores', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  await page.goto('/stock?all=1&tab=low');
  await page.getByTestId('stock-row').first().getByRole('link').click();
  await page.waitForURL('**/stock/items/**');
  await page.getByRole('link', { name: '← Back' }).click();
  await expect(page).toHaveURL(/\/stock\?.*all=1.*tab=low/);
  await expect(page.getByTestId('tab-low')).toHaveAttribute('aria-current', 'page');
});
