import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Items thrown away only once the GM approves (ADR 092) at 380 px on Test Hotel 1.0's bar
// store: the head bartender asks to throw away a bottle of single malt; the GM gives it to another
// bartender, who throws it away. Who may is proved in packages/db/src/stock-policies.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('the GM approves throwing away the single malt; a bartender throws it away', async ({
  page,
}) => {
  const store = await placeId('TEST-HOTEL-1.0-BAR-STORE');
  const started = new Date();
  try {
    await signInAs(page, 'Test Head Bartender 1.0');
    await page.goto(`/stock/wastage?node=${store}`);
    await main(page).getByLabel('Find an item').fill('Single Malt');
    await main(page).getByRole('button', { name: 'Test Single Malt 750ml' }).click();
    await expect(main(page).getByTestId('needs-gm')).toBeVisible();
    await main(page)
      .getByLabel(/^Quantity/)
      .fill('1');
    await main(page)
      .getByRole('group', { name: 'Reason' })
      .getByRole('button', { name: 'Damaged' })
      .click();
    await main(page).getByRole('button', { name: 'Ask the GM' }).click();
    await expect(main(page).getByText(/Once the GM approves/)).toBeVisible();

    const [task] = await asMigrator<{ id: string }>(
      `select id from ops.task where kind = 'discard' and delivery_node_id = $1
          and created_at >= $2 order by created_at desc limit 1`,
      [store, started],
    );
    await page.goto(`/tasks/${task!.id}`);
    await expect(page.getByTestId('discard-waiting')).toContainText('Waiting for the GM');

    await signInAs(page, 'Test General Manager 1.0');
    await page.goto(`/tasks/${task!.id}`);
    const who = main(page).getByLabel('Who throws it away');
    const bartenderB = await who
      .locator('option', { hasText: 'Test Bartender B 1.0' })
      .getAttribute('value');
    await who.selectOption(bartenderB);
    await main(page).getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('task-status')).toContainText('Test Bartender B 1.0');

    await signInAs(page, 'Test Bartender B 1.0');
    await page.goto(`/tasks/${task!.id}`);
    await main(page)
      .getByLabel(/Throw it away/)
      .fill('1');
    await main(page).getByRole('button', { name: 'Record it thrown away' }).click();
    await expect(page.getByTestId('task-status')).toHaveText(/^Done/);
  } finally {
    // back as it was: the ledger is append-only, so the bottle is put back with a correction
    await asMigrator(
      `insert into inv.stock_ledger (tenant_id, delivery_node_id, item_id, qty, movement_type,
                                     ref_type, ref_id, created_by, updated_by)
       select w.tenant_id, w.delivery_node_id, w.item_id, w.qty, 'count_adjust',
              'e2e', w.id, w.created_by, w.created_by
         from inv.wastage_line w join ops.task t on t.id = w.task_id
        where t.kind = 'discard' and t.delivery_node_id = $1 and t.created_at >= $2`,
      [store, started],
    );
  }
});
