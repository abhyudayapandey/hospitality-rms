import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// An item's page (ADR 134) at 380 px: five latest movements and Show all, its requests, then
// Ask for more, which opens Ask for stock with the item first.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('the sous chef asks for more rice from its page', async ({ page }) => {
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  const [rice] = await asMigrator<{ id: string; moves: number }>(
    `select i.id::text, (select count(*)::int from inv.stock_ledger l
                          where l.item_id = i.id and l.delivery_node_id = $1) as moves
       from inv.item i where i.sku = 'BASMATI-RICE' and i.tenant_id =
            (select tenant_id from core.hierarchy_node where id = $1)`,
    [kitchen],
  );
  await signInAs(page, 'Test Sous Chef 1.0');
  await page.goto(`/stock/items/${rice!.id}?node=${kitchen}`);
  await expect(main(page).getByRole('heading', { name: 'Latest movements' })).toBeVisible();
  await expect(main(page).getByRole('heading', { name: 'Requests' })).toBeVisible();
  if (rice!.moves > 5) {
    await expect(main(page).getByTestId('movements-all')).toHaveText(
      `Show all ${Math.min(rice!.moves, 50)}`,
    );
  }
  // the hotel has a Main Store: more rice is asked of it, the rice first and ready to type
  await main(page).getByTestId('ask-for-more').click();
  await page.waitForURL(/\/stock\/transfers\/new\?.*item=/);
  const box = page.getByRole('textbox', { name: 'Ask for Test Basmati Rice' });
  await expect(box).toBeFocused();
  await expect(
    page.getByTestId('from-Main Store').getByRole('textbox').first(),
  ).toHaveAccessibleName('Ask for Test Basmati Rice');
});
