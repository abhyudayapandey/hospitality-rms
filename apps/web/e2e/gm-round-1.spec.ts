import { expect, test } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// The Passport GM's first round, the rest of it (ADR 078 to 082), at 380 px, as the people who
// use each screen: a commis's steps with their pictures; the chef's checklist editor choosing
// one; a bar's count sheet showing each row's pack; the Main Store keeper sending a delivery
// straight to the kitchen with its expiry; the restaurant manager rostering by person with
// tiles. (The menu's dish recipe is in menu.spec.ts, the minibar's tasks in minibar.spec.ts.)
// The rules behind each are in the DB tests named in their ADRs.

test.use({ viewport: { width: 380, height: 900 } });

test('a commis sees a picture for each step; the chef chooses one in the editor', async ({
  page,
}) => {
  await signInAs(page, 'Test Commis 1.0');
  await page.goto('/tasks');
  await page
    .getByRole('link', { name: /Kitchen opening/ })
    .first()
    .click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  // the task's own picture beside its title, and the step's (file 29 names the fridge)
  await expect(page.getByTestId('task-title').locator('svg')).toHaveCount(1);
  await expect(page.getByTestId('step-icon').first()).toHaveAttribute('data-icon', 'fridge');

  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto('/tasks/checklists');
  await page
    .getByRole('link', { name: /Kitchen opening/ })
    .first()
    .click();
  const pictures = page.getByTestId('step-pictures');
  await expect(pictures).toBeVisible();
  await expect(pictures.getByLabel('Picture for Walk-in chiller temperature')).toHaveValue(
    'fridge',
  );
  // a step that names none is picked from its words, and says so
  const hand = pictures.getByLabel('Picture for Hand-wash station stocked');
  await expect(hand).toHaveValue('');
  await expect(hand.locator('option').first()).toHaveText('From its words (Hand wash)');
});

test("the count sheet shows each row's pack, so a bottle is never a nip", async ({ page }) => {
  const store = await placeId('TEST-SOLO-BAR-BAR-STORE');
  const clear = async () => {
    await asMigrator(
      `delete from inv.stock_check_line where check_id in
         (select id from inv.stock_check where delivery_node_id = $1 and status <> 'finished')`,
      [store],
    );
    await asMigrator(
      `delete from inv.stock_check where delivery_node_id = $1 and status <> 'finished'`,
      [store],
    );
  };
  await clear();
  try {
    await signInAs(page, 'Test Accountant');
    await page.goto(`/stock/check?node=${store}`);
    await page.getByRole('button', { name: 'Start a stock check' }).click();
    await page.waitForURL(/\/stock\/check\/[0-9a-f-]{36}/);
    const vodka = page.locator('li').filter({ hasText: 'Test Vodka 750ml' }).first();
    await expect(vodka.getByTestId('pack')).toHaveText('750 ml bottle');
    await expect(vodka.getByTestId('pack')).toHaveAttribute('data-icon', 'bottle');
  } finally {
    await clear();
  }
});

test('the Main Store keeper sends a delivery straight to the kitchen, with its expiry', async ({
  page,
}) => {
  const [main, kitchen] = [
    await placeId('TEST-HOTEL-1.0-MAIN-STORE'),
    await placeId('TEST-HOTEL-1.0-KITCHEN-STORE'),
  ];
  // the kitchen's order, placed by its Main Store and not yet received
  const [po] = await asMigrator<{ id: string }>(
    `insert into inv.purchase_order (tenant_id, delivery_node_id, status, ordered_at, released_at,
                                     notes)
     select tenant_id, $1, 'released', now(), now(), 'e2e: straight to the kitchen'
       from core.hierarchy_node where id = $1 returning id`,
    [kitchen],
  );
  await asMigrator(
    `insert into inv.purchase_order_line (tenant_id, po_id, item_id, delivery_node_id, qty, unit_cost)
     select i.tenant_id, $1, i.id, $2, 5, 120 from inv.item i
      join core.tenant t on t.id = i.tenant_id
      where t.code = 'TEST-COMPANY' and i.sku = 'BASMATI-RICE'`,
    [po!.id, kitchen],
  );
  const expiry = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/orders/${po!.id}?node=${main}`);
  const form = page.getByTestId('receive-form');
  const line = form.getByTestId('receive-line').filter({ hasText: 'Test Basmati Rice' });
  // the item goes into the store by default (file 10); the keeper sends this one on
  const dest = line.getByTestId('receive-dest');
  await expect(dest.getByRole('radio', { name: 'Into the store' })).toBeChecked();
  await dest.getByText(/^To /).click();
  await line.getByRole('textbox', { name: 'Received Test Basmati Rice' }).fill('5');
  await line.getByRole('textbox', { name: 'Amount Test Basmati Rice' }).fill('600');
  await line.getByLabel('Expiry Test Basmati Rice').fill(expiry);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.getByTestId('po-paid')).toContainText('₹');
  // in the ledger: a receipt at the Main Store, issued on to the kitchen at once, dated
  const rows = await asMigrator<{ store: string; movement_type: string; dated: boolean }>(
    `select h.code as store, l.movement_type, l.expires_at is not null as dated
       from inv.stock_ledger l join core.hierarchy_node h on h.id = l.delivery_node_id
      where (l.ref_type = 'goods_receipt' and l.ref_id in
               (select id from inv.goods_receipt where po_id = $1))
         or (l.ref_type = 'transfer' and l.ref_id in
               (select issue_id from inv.goods_receipt_line g
                  join inv.goods_receipt r on r.id = g.receipt_id where r.po_id = $1))
      order by l.movement_type`,
    [po!.id],
  );
  expect(rows).toEqual([
    { store: 'TEST-HOTEL-1.0-MAIN-STORE', movement_type: 'receipt', dated: true },
    { store: 'TEST-HOTEL-1.0-KITCHEN-STORE', movement_type: 'transfer_in', dated: true },
    { store: 'TEST-HOTEL-1.0-MAIN-STORE', movement_type: 'transfer_out', dated: true },
  ]);
});

test('the restaurant manager rosters by person: a tile for each shift type, and Off', async ({
  page,
}) => {
  const restaurant = await placeId('TEST-HOTEL-1.0-RESTAURANT');
  const [{ monday, day } = { monday: '', day: '' }] = await asMigrator<{
    monday: string;
    day: string;
  }>(
    `select (date_trunc('week', now() at time zone 'Asia/Kolkata')::date + 28)::text as monday,
            (date_trunc('week', now() at time zone 'Asia/Kolkata')::date + 30)::text as day`,
    [],
  );
  const cleanup = () =>
    asMigrator(
      `with s as (select s.id from hr.shift s join hr.shift_template t on t.id = s.template_id
                   where s.org_node_id = $1 and s.local_date = $2::date and t.name = 'Split')
       , a as (delete from hr.shift_assignment where shift_id in (select id from s))
       delete from hr.shift where id in (select id from s)`,
      [restaurant, day],
    );
  await cleanup();
  try {
    await signInAs(page, 'Test Restaurant Manager 1.0');
    await page.goto(`/roster/week?node=${restaurant}&week=${monday}&day=${day}`);
    await page.getByTestId('view-people').click();
    await page.waitForURL(/view=people/);
    const row = page.getByTestId('person-row').filter({ hasText: 'Test Steward C 1.0' });
    const split = row.getByTestId('shift-tile').filter({ hasText: 'Split' });
    await expect(split).toContainText('11:00–15:00 · 18:00–23:00 · 9 h');
    await split.click();
    await expect(split).toHaveAttribute('aria-pressed', 'true');
    const off = row.getByTestId('shift-tile').and(page.locator('[data-type="off"]'));
    await off.click();
    await expect(off).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('form', { name: 'Repeat this pattern' })).toBeVisible();
  } finally {
    await cleanup();
  }
});
