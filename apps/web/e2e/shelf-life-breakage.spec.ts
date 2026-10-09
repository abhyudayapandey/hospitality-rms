import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Shelf life & labels and Breakage (ADR 093) at 380 px on Test Hotel 1.0. A chef opens a litre
// of milk: its label has the use-by day's dot and the allergens, and it is used up. A room
// attendant records a torn bath towel; the restaurant manager, a department head there, sees
// it in the outlet's breakage. Who may is proved in shelf-life-breakage.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('an opened pack is labelled, listed and used up', async ({ page }) => {
  const store = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  const started = new Date();
  try {
    await signInAs(page, 'Test Chef de Partie 1.0');
    await page.goto(`/stock/opened?node=${store}`);
    await main(page).getByLabel('What you opened').selectOption({ label: 'Test Milk (l)' });
    await expect(main(page).getByTestId('pack-keeps')).toContainText('Keeps 2 days once opened');
    await main(page)
      .getByLabel(/^How much/)
      .fill('1');
    await main(page).getByRole('button', { name: 'Open and print the label' }).click();
    await page.waitForURL(/\/stock\/opened\/label\//);
    const label = page.getByTestId('pack-label');
    await expect(label).toContainText('Test Milk');
    await expect(label.getByTestId('label-allergens')).toHaveText('Contains milk');
    await expect(label).toContainText('Keep chilled');
    await expect(label.getByTestId('day-dot')).toBeVisible();
    await expect(label.getByTestId('label-opened-by')).toHaveText('Test Chef de Partie 1.0');

    await page.goto(`/stock/opened?node=${store}`);
    const pack = main(page).getByTestId('open-pack').filter({ hasText: 'Test Milk' });
    await expect(pack).toHaveCount(1);
    await pack.getByRole('button', { name: 'Used up' }).click();
    await expect(main(page).getByTestId('open-pack')).toHaveCount(0);
  } finally {
    await asMigrator(
      `delete from inv.opened_pack where delivery_node_id = $1 and created_at >= $2`,
      [store, started],
    );
  }
});

test("a breakage leaves the store and is in the outlet's log", async ({ page }) => {
  const housekeeping = await placeId('TEST-HOTEL-1.0-HOUSEKEEPING');
  const outlet = await placeId('TEST-HOTEL-1.0');
  const started = new Date();
  try {
    await signInAs(page, 'Test Room Attendant 1.0');
    await page.goto(`/breakage?place=${housekeeping}`);
    await main(page).getByLabel('What broke').selectOption({ label: 'Test Bath Towel (each)' });
    await main(page)
      .getByLabel(/^How many/)
      .fill('1');
    await main(page).getByLabel('How', { exact: true }).selectOption('worn_out');
    await main(page).getByLabel('Who broke it').selectOption('staff');
    await main(page)
      .getByLabel(/^Who on the staff/)
      .selectOption({ label: 'Test Room Attendant B 1.0' });
    await main(page).getByRole('button', { name: 'Record the breakage' }).click();
    await expect(main(page).getByText('Recorded: Test Bath Towel, 1 each.')).toBeVisible();
    await expect(
      main(page).getByTestId('breakage-row').filter({ hasText: 'Test Bath Towel' }),
    ).toContainText('Test Room Attendant B 1.0');

    await signInAs(page, 'Test Restaurant Manager 1.0');
    await page.goto(`/breakage?place=${outlet}`);
    await expect(
      main(page).getByTestId('breakage-row').filter({ hasText: 'Test Bath Towel' }),
    ).toContainText('Housekeeping');
  } finally {
    // the ledger is append-only: the towel goes back with a correction
    await asMigrator(
      `insert into inv.stock_ledger (tenant_id, delivery_node_id, item_id, qty, movement_type,
                                     ref_type, ref_id, created_by, updated_by)
       select tenant_id, delivery_node_id, item_id, qty, 'count_adjust', 'e2e', id,
              created_by, created_by
         from inv.breakage where org_node_id = $1 and created_at >= $2`,
      [housekeeping, started],
    );
    await asMigrator(`delete from inv.breakage where org_node_id = $1 and created_at >= $2`, [
      housekeeping,
      started,
    ]);
  }
});
