import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// The Main Store keeper's day (ADR 051) through the real screens: Orders in one list with the
// departments' requests, receiving at actual amounts with "Bill missing" until the bill is in,
// and Send stock to a department, confirmed by the person who gets the task. The rules are in
// store-keeper-flow.db.test.ts.

/** The vertical position of an element, to check what comes first on the screen. */
const top = async (page: Page, selector: ReturnType<Page['getByTestId']>) =>
  (await selector.boundingBox())!.y;

test('Orders: To receive counts what it lists, the departments’ requests included; asking is a link below', async ({
  page,
}) => {
  const main = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/orders?node=${main}&tab=receive`);
  const rows = page.getByTestId('po-item');
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  await expect(page.getByTestId('tab-receive')).toHaveText(`To receive (${n})`);
  await expect(page.getByText('Nothing is waiting to be received.')).toHaveCount(0);
  // the kitchen's requests say whom they are for
  await expect(rows.getByTestId('order-store').first()).toContainText('for ');
  await expect(page.getByTestId('tab-received')).toBeVisible();
  // the Main Store is asked for supplies: its own asking is a small link, after the list
  const ask = page.getByRole('link', { name: 'Ask for supplies for the Main Store' });
  await expect(ask).toBeVisible();
  expect(
    await top(page, page.getByRole('link', { name: 'Ask for supplies for the Main Store' })),
  ).toBeGreaterThan(await top(page, rows.last()));
});

test('receiving: nothing filled in, an amount for each item, and "Bill missing" until the bill is in', async ({
  page,
}) => {
  const main = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/orders?node=${main}&tab=receive`);
  await page.getByTestId('po-item').first().getByRole('link').click();
  await page.waitForURL(/\/stock\/orders\/[0-9a-f-]{36}/);
  const po = new URL(page.url()).pathname.split('/').pop()!;
  const form = page.getByTestId('receive-form');
  const lines = form.getByTestId('receive-line');
  await expect(lines.first()).toBeVisible();
  for (const input of await form.getByRole('textbox', { name: /^(Received|Amount) / }).all()) {
    await expect(input).toHaveValue('');
  }
  const name = (await lines.first().locator('span.font-medium').textContent())!;
  await form.getByRole('textbox', { name: `Received ${name}` }).fill('1');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText(`Enter the amount for ${name}`);
  await form.getByRole('textbox', { name: `Amount ${name}` }).fill('120');
  await expect(form.getByTestId('receive-total')).toContainText('₹120.00');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.getByTestId('po-paid')).toContainText('₹');
  await expect(page.getByTestId('bill-missing')).toBeVisible();

  // the GM and the department head see it at once
  for (const who of ['Test General Manager 1.0', 'Test Executive Chef 1.0']) {
    await signInAs(page, who);
    await page.goto(`/stock/orders/${po}`);
    await expect(page.getByTestId('bill-missing')).toBeVisible();
  }
  const kitchen = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await page.goto(`/stock/orders?node=${kitchen}`);
  await expect(page.locator(`[data-po-id="${po}"]`).getByTestId('bill-missing')).toHaveText(
    'Bill missing',
  );
});

test('Send stock: it leaves the Main Store, the person who gets the task confirms what arrived', async ({
  page,
}) => {
  const main = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/transfers?node=${main}`);
  // the Main Store gives stock out: Send stock leads, Request stock is a small link
  await expect(page.getByRole('link', { name: 'Send stock' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Request stock' })).toBeVisible();
  await page.getByRole('link', { name: 'Send stock' }).click();
  await page.getByTestId('send-to').getByRole('link', { name: 'Kitchen Store' }).click();
  await page.waitForURL(/to=/);
  const form = page.getByTestId('send-stock');
  // an item the Main Store has
  const row = form.locator('li').filter({ hasNotText: 'in stock here: 0 ' }).first();
  const item = (await row.getByTestId('item-name').textContent())!.trim();
  await form.getByRole('textbox', { name: `Send ${item}` }).fill('1');
  await page.getByRole('button', { name: 'Send 1 item' }).click();
  await page.waitForURL(/\/stock\/transfers\?node=/);
  const sent = page.getByTestId('transfer-item').first();
  await expect(sent).toContainText('Sent · To ');
  await expect(sent.getByTestId('transfer-progress')).toHaveText('in transit');

  // the task went to whoever is on shift in the kitchen, else its head
  const [task] = await asMigrator<{ id: string; who: string }>(
    `select t.id, u.display_name as who from ops.task t
       join core.app_user u on u.id = t.assignee_user_id
      where t.kind = 'receive' order by t.created_at desc limit 1`,
    [],
  );
  let who = task!.who;
  if (who === 'Test Executive Chef 1.0') {
    // nobody on shift: the head passes it on
    await signInAs(page, who);
    await page.goto(`/tasks/${task!.id}`);
    const reassign = page.getByTestId('reassign');
    await reassign.getByRole('combobox').selectOption({ label: 'Test Commis 1.0 (Commis)' });
    await reassign.getByRole('button', { name: 'Assign' }).click();
    await expect(page.getByTestId('task-status')).toContainText('With Test Commis 1.0');
    who = 'Test Commis 1.0';
  }
  await signInAs(page, who);
  await page.goto(`/tasks/${task!.id}`);
  const confirm = page.getByTestId('receive-sent');
  await expect(confirm.getByRole('textbox', { name: `Arrived ${item}` })).toHaveValue('');
  await confirm.getByRole('button', { name: 'Everything arrived' }).click();
  await confirm.getByRole('button', { name: 'Confirm what arrived' }).click();
  await expect(page.getByTestId('task-status')).toContainText('Done');
  await expect(page.getByTestId('sent-lines')).toContainText('arrived 1');
});

test('every store sees the Main Store’s materials, grouped: the bar gets ketchup, foil, cling film', async ({
  page,
}) => {
  const main = await placeId('TEST-HOTEL-1.0-MAIN-STORE');
  const bar = await placeId('TEST-HOTEL-1.0-BAR-STORE');
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/transfers/send?node=${main}&to=${bar}`);
  // grouped, the bar's own group first (ADR 051 addendum)
  await expect(page.getByTestId('group-kitchen_bar').getByRole('heading')).toHaveText(
    'Kitchen & Bar items',
  );
  for (const item of ['Test Tomato Ketchup', 'Test Aluminium Foil Roll', 'Test Cling Film Roll']) {
    await expect(page.getByRole('textbox', { name: `Send ${item}` })).toBeVisible();
  }
  await signInAs(page, 'Test Bar Manager 1.0');
  await page.goto(`/stock/transfers/new?node=${bar}&from=${main}`);
  await expect(page.getByRole('textbox', { name: 'Request Test Tomato Ketchup' })).toBeVisible();
});
