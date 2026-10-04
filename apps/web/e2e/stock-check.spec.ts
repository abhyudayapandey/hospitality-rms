import { expect, test } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// The stock check (INV-10, INV-11, INV-7, INV-8; ADR 043) through the real screens. There is
// no photo bucket in this environment, so a difference (which needs a photo) stops at the
// notice; the photo path and the posting are in the DB tests (stock-check.db.test.ts).

const HOTEL_KITCHEN = 'TEST-HOTEL-1.0-KITCHEN-STORE';
const SOLO_BAR = 'TEST-SOLO-BAR-BAR-STORE';

/** An earlier run's unfinished check would be resumed: clear it (setup as migrator). */
async function clearOpenChecks(store: string): Promise<void> {
  const node = await placeId(store);
  await asMigrator(
    `delete from inv.stock_check_line where check_id in
       (select id from inv.stock_check where delivery_node_id = $1 and status <> 'finished')`,
    [node],
  );
  await asMigrator(
    `delete from inv.stock_check where delivery_node_id = $1 and status <> 'finished'`,
    [node],
  );
}

/** An item with stock at the store, whole units if asked: its name and quantity on record. */
async function anItem(store: string, whole = false): Promise<{ name: string; onHand: number }> {
  const [row] = await asMigrator<{ name: string; on_hand: string }>(
    `select i.name, s.on_hand::text from inv.stock_level s
       join inv.item i on i.id = s.item_id join core.hierarchy_node h on h.id = s.delivery_node_id
      where h.code = $1 and s.on_hand > 0 ${whole ? 'and s.on_hand = trunc(s.on_hand)' : ''}
      order by i.name limit 1`,
    [store],
  );
  return { name: row!.name, onHand: Number(row!.on_hand) };
}

test('the Cost Controller counts blind and finishes; the GM then sees Verified, by whom', async ({
  page,
}) => {
  await clearOpenChecks(HOTEL_KITCHEN);
  const store = await placeId(HOTEL_KITCHEN);
  const item = await anItem(HOTEL_KITCHEN);

  await signInAs(page, 'Test Cost Controller 1.0');
  await page.goto(`/stock/check?node=${store}`);
  // the count is blind: what is on record is not shown to the verifier
  await expect(page.getByText('on record')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start a stock check' }).click();
  await page.waitForURL(/\/stock\/check\/[0-9a-f-]{36}/);
  await expect(page.getByText('on record')).toHaveCount(0);

  const count = page.getByRole('textbox', { name: `Counted ${item.name}` });
  await count.fill(String(item.onHand));
  await count.blur();
  await expect(page.locator('li').filter({ hasText: item.name })).toContainText('saved');
  await page.getByRole('button', { name: /^Show the differences/ }).click();
  await expect(page.getByText('Everything counted matches.')).toBeVisible();
  await page.getByRole('button', { name: 'Finish stock check' }).click();
  await expect(page.getByRole('status').last()).toContainText('Finished');

  await signInAs(page, 'Test General Manager 1.0');
  await page.goto(`/stock/check?node=${store}`);
  await expect(
    page.locator('li').filter({ hasText: item.name }).getByTestId('tag-verified'),
  ).toContainText('Test Cost Controller 1.0');
  // the GM sees the tags and the quantity on record, and cannot start a check
  await expect(page.getByText('on record').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Start a/ })).toHaveCount(0);

  // a stock user may not even open it
  await signInAs(page, 'Test Chef de Partie 1.0');
  await page.goto(`/stock/check?node=${store}`);
  await expect(page.getByRole('button', { name: /^Start a/ })).toHaveCount(0);
  await expect(page.getByTestId('tag-verified')).toHaveCount(0);
});

test('a different count shows the difference and cannot be finished without a photo', async ({
  page,
}) => {
  await clearOpenChecks(HOTEL_KITCHEN);
  const store = await placeId(HOTEL_KITCHEN);
  const item = await anItem(HOTEL_KITCHEN);

  await signInAs(page, 'Test Cost Controller 1.0');
  await page.goto(`/stock/check?node=${store}`);
  await page.getByRole('button', { name: 'Start a stock check' }).click();
  await page.waitForURL(/\/stock\/check\/[0-9a-f-]{36}/);
  const count = page.getByRole('textbox', { name: `Counted ${item.name}` });
  await count.fill(String(item.onHand + 1));
  await count.blur();
  await expect(page.locator('li').filter({ hasText: item.name })).toContainText('saved');
  await page.getByRole('button', { name: /^Show the differences/ }).click();
  const diff = page.getByTestId('difference');
  await expect(diff).toHaveCount(1);
  await expect(diff).toContainText(item.name);
  await expect(diff).toContainText('expected');
  // counts are locked now, and with no photo bucket here the check cannot be finished
  await expect(page.getByRole('button', { name: 'Finish stock check' })).toBeDisabled();
  await clearOpenChecks(HOTEL_KITCHEN);
});

test('a bar check counts bottles and tenths (the Stock Verifier of the solo bar)', async ({
  page,
}) => {
  await clearOpenChecks(SOLO_BAR);
  const store = await placeId(SOLO_BAR);
  const item = await anItem(SOLO_BAR, true);

  await signInAs(page, 'Test Stock Verifier');
  await page.goto(`/stock/check?node=${store}`);
  await page.getByRole('button', { name: /^Start a bar check/ }).click();
  await page.waitForURL(/\/stock\/check\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { name: /^Bar check at/ })).toBeVisible();
  const full = page.getByRole('textbox', { name: `Full ${item.name}` });
  await full.fill(String(item.onHand));
  await full.blur();
  await page
    .getByRole('combobox', { name: `Tenths of the open bottle of ${item.name}` })
    .selectOption('0');
  await page.getByRole('combobox', { name: `Tenths of the open bottle of ${item.name}` }).blur();
  await expect(page.locator('li').filter({ hasText: item.name })).toContainText('saved');
  await page.getByRole('button', { name: /^Show the differences/ }).click();
  await expect(page.getByText('Everything counted matches.')).toBeVisible();
  await page.getByRole('button', { name: 'Finish stock check' }).click();
  await expect(page.getByRole('status').last()).toContainText('Finished');
});

test('offline: a count is saved on the phone and sent, with its time, when the signal is back', async ({
  page,
  context,
}) => {
  await clearOpenChecks(HOTEL_KITCHEN);
  const store = await placeId(HOTEL_KITCHEN);
  const item = await anItem(HOTEL_KITCHEN);

  await signInAs(page, 'Test Cost Controller 1.0');
  await page.goto(`/stock/check?node=${store}`);
  await page.getByRole('button', { name: 'Start a stock check' }).click();
  await page.waitForURL(/\/stock\/check\/[0-9a-f-]{36}/);
  const id = new URL(page.url()).pathname.split('/').pop()!;

  await context.setOffline(true);
  const count = page.getByRole('textbox', { name: `Counted ${item.name}` });
  await count.fill(String(item.onHand));
  await count.blur();
  await expect(page.getByTestId('check-waiting')).toContainText('1 count saved on this phone');
  await expect(page.getByRole('button', { name: /^Show the differences/ })).toBeDisabled();

  await context.setOffline(false); // 'online' makes <ActionSync> replay it
  await expect(page.getByTestId('check-waiting')).toHaveCount(0);
  const [saved] = await asMigrator<{ counted_qty: string; counted_at: Date }>(
    `select l.counted_qty::text, l.counted_at from inv.stock_check_line l
       join inv.item i on i.id = l.item_id where l.check_id = $1 and i.name = $2`,
    [id, item.name],
  );
  expect(Number(saved!.counted_qty)).toBe(item.onHand);
  // the time it was counted, not the time it synced
  expect(Date.now() - new Date(saved!.counted_at).getTime()).toBeLessThan(120_000);
  await clearOpenChecks(HOTEL_KITCHEN);
});
