import { expect, test } from '@playwright/test';
import { asMigrator, placeId, runExecutor, signInAs } from './helpers';

// A request follows the stock (ADR 115), at Test Hotel 1.0, which has a Main Store: housekeeping
// asks for bath towels (no store picked); the store keeper gives it to the purchase manager, who
// takes it down; whoever asked receives it and sees each step. Then a room attendant asks their
// head, who gives it, and the attendant sees it given.

async function stockAtMain(item: string, qty: number) {
  await asMigrator(
    `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                   unit_cost, ref_type)
     select i.tenant_id, i.id, n.id, 'count_adjust', $3, 300, 'e2e'
       from inv.item i join core.hierarchy_node n on n.code = $2 and n.tenant_id = i.tenant_id
      where i.name = $1`,
    [item, 'TEST-HOTEL-1.0-MAIN-STORE', qty],
  );
}

test('housekeeping asks, the Main Store gives it to someone who takes it down, housekeeping follows it', async ({
  page,
}) => {
  await stockAtMain('Test Bath Towel', 20);
  const hk = await placeId('TEST-HOTEL-1.0-HOUSEKEEPING-STORE');

  await signInAs(page, 'Test Executive Housekeeper 1.0');
  await page.goto(`/stock/transfers/new?node=${hk}`);
  await expect(page.getByTestId('from-Main Store')).toContainText('Test Bath Towel');
  await page.getByRole('textbox', { name: 'Request Test Bath Towel' }).fill('6');
  await page.getByRole('textbox', { name: /What it is for/ }).fill('Floor 2 linen room');
  await page.getByRole('button', { name: 'Request 1 item' }).click();
  await page.waitForURL(/\/stock\/transfers\/[0-9a-f-]{36}/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByTestId('request-now')).toContainText('With the Main Store');
  // RFMs → History: a stock request, what was asked and where it is, never "Transfer"
  await page.goto('/requests?tab=history');
  const row = page.getByTestId('request-item').filter({ hasText: '6 × Test Bath Towel' }).first();
  await expect(row).toContainText('Request');
  await expect(row.getByTestId('request-now')).toContainText('With the Main Store');
  await expect(row).not.toContainText('Transfer');

  // the keeper gives it to the purchase manager
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/transfers/${id}`);
  await page.getByRole('button', { name: 'Give to someone' }).click();
  await page.getByRole('button', { name: /Test Purchase Manager 1\.0/ }).click();
  await expect(page.getByRole('status')).toContainText('Given to Test Purchase Manager 1.0');

  // housekeeping sees who is bringing it
  await signInAs(page, 'Test Executive Housekeeper 1.0');
  await page.goto(`/stock/transfers/${id}`);
  await expect(page.getByTestId('request-now')).toContainText(
    'Test Purchase Manager 1.0 is bringing it from the Main Store',
  );

  // the purchase manager's To do: one tap when all of it went
  await signInAs(page, 'Test Purchase Manager 1.0');
  await page.goto('/tasks');
  await page
    .getByRole('link', { name: /Send to Housekeeping Store/ })
    .first()
    .click();
  await expect(page.getByTestId('send-task')).toContainText('Test Bath Towel');
  await page.getByRole('button', { name: 'I took all of it' }).click();
  await runExecutor();

  // whoever asked receives it, nothing filled in, and sees the whole story
  await signInAs(page, 'Test Executive Housekeeper 1.0');
  await page.goto(`/stock/transfers/${id}`);
  await expect(page.getByTestId('request-now')).toContainText('On the way');
  await page.getByRole('button', { name: 'Everything arrived' }).click();
  await page.getByRole('button', { name: 'Transfer to Housekeeping done' }).click();
  await expect(page.getByTestId('receive-sent')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('request-now')).toContainText('Received by');
  const story = page.getByTestId('request-story');
  for (const step of [
    'Asked by Test Executive Housekeeper 1.0',
    'Given to Test Purchase Manager 1.0 to send',
    'Sent by Test Purchase Manager 1.0',
    'Received by Test Executive Housekeeper 1.0',
  ]) {
    await expect(story).toContainText(step);
  }
});

test('a room attendant asks their head, who gives it; the attendant sees it given', async ({
  page,
}) => {
  await signInAs(page, 'Test Room Attendant 1.0');
  await page.goto('/me');
  // RFMs open on Ask for whoever has a store to ask (ADR 143)
  await page.getByTestId('me-requests').click();
  await expect(page.getByTestId('tab-ask')).toHaveAttribute('aria-current', 'page');
  const towel = page.getByRole('listitem').filter({ hasText: 'Test Hand Towel' });
  // + on an empty box gives 1, never 0
  await towel.getByRole('button', { name: 'More' }).click();
  await expect(towel.getByRole('textbox')).toHaveValue('1');
  await page.getByRole('textbox', { name: /What it is for/ }).fill('Room 104');
  await page.getByRole('button', { name: 'Request 1 item' }).click();
  await page.waitForURL(/\/stock\/asks\/[0-9a-f-]{36}/);
  const ask = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByTestId('request-now')).toContainText('Test Executive Housekeeper 1.0');
  await expect(page.getByTestId('head-actions')).toHaveCount(0);

  // the head gives it from the store
  await signInAs(page, 'Test Executive Housekeeper 1.0');
  await page.goto(`/stock/asks/${ask}`);
  await expect(page.getByTestId('ask-lines')).toContainText('Test Hand Towel');
  await page.getByRole('button', { name: 'Give it', exact: true }).click();
  await expect(page.getByTestId('request-now')).toHaveAttribute('data-stage', 'to_collect');
  // the head sees by when it should reach the department (ADR 143)
  await expect(page.getByTestId('collect-due')).toContainText(
    'Test Room Attendant 1.0 takes it there by',
  );

  // the attendant follows it, then takes it to the department (ADR 142)
  await signInAs(page, 'Test Room Attendant 1.0');
  await page.goto('/requests?tab=history');
  await expect(page.getByTestId('ask-item').first()).toContainText('Test Hand Towel');
  await page.getByTestId('ask-item').first().getByRole('link').click();
  await page.waitForURL(`**/stock/asks/${ask}`);
  await expect(page.getByTestId('request-story')).toContainText(
    'Given by Test Executive Housekeeper 1.0',
  );
  await expect(page.getByTestId('collect-due')).toContainText('Take it there by');
  await page.getByRole('button', { name: 'Transfer to Housekeeping done' }).click();
  await expect(page.getByTestId('collect-due')).toHaveCount(0);
  await expect(page.getByTestId('request-now')).toHaveAttribute('data-stage', 'given');
  await expect(page.getByTestId('collect')).toHaveCount(0);
  // newest first: the handover heads the history
  await expect(page.getByTestId('request-story').getByRole('listitem').first()).toContainText(
    'Taken to the Housekeeping by Test Room Attendant 1.0',
  );
});

test('the head rejects an ask; whoever asked sees it rejected, why, and by whom', async ({
  page,
}) => {
  const reason = `Enough towels in the linen room (${Date.now() % 100000})`;
  await signInAs(page, 'Test Room Attendant 1.0');
  await page.goto('/requests?tab=ask');
  const towel = page.getByRole('listitem').filter({ hasText: 'Test Hand Towel' });
  // + on an empty box gives 1, never 0
  await towel.getByRole('button', { name: 'More' }).click();
  await expect(towel.getByRole('textbox')).toHaveValue('1');
  await page.getByRole('button', { name: 'Request 1 item' }).click();
  await page.waitForURL(/\/stock\/asks\/[0-9a-f-]{36}/);
  const ask = new URL(page.url()).pathname.split('/').pop()!;

  // the head can't give it, and says why
  await signInAs(page, 'Test Executive Housekeeper 1.0');
  await page.goto(`/stock/asks/${ask}`);
  await page.getByRole('button', { name: 'Can’t give it', exact: true }).click();
  await page.getByPlaceholder('Enough in the room').fill(reason);
  await page.getByTestId('ask-no').getByRole('button', { name: 'Can’t give it' }).click();
  await expect(page.getByTestId('request-now')).toHaveText(`Rejected: ${reason}`);

  // whoever asked: Given to others says rejected; tapping it opens the ask, not a "Done" task
  await signInAs(page, 'Test Room Attendant 1.0');
  await page.goto('/tasks');
  const row = page
    .getByTestId('tasks-given')
    .getByRole('listitem')
    .filter({
      hasText: `Rejected by Test Executive Housekeeper 1.0: ${reason}`,
    });
  await expect(row).toContainText('rejected');
  await row.getByRole('link').click();
  await page.waitForURL(new RegExp(`/stock/asks/${ask}`));
  await expect(page.getByTestId('request-now')).toHaveAttribute('data-stage', 'closed');
  await expect(page.getByTestId('request-now')).toHaveText(`Rejected: ${reason}`);
  await expect(page.getByTestId('request-story')).toContainText(
    `Rejected by Test Executive Housekeeper 1.0: ${reason}`,
  );
});

test('RFMs: Ask, Transfer for whoever moves stock, and History (ADR 143)', async ({ page }) => {
  // a room attendant: no Transfers tab
  await signInAs(page, 'Test Room Attendant 1.0');
  await page.goto('/requests');
  await expect(page.getByTestId('tab-ask')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('tab-transfers')).toHaveCount(0);
  // History holds materials only: asks and requests for stock, never leave
  await page.getByTestId('tab-history').click();
  await expect(page.locator('main')).not.toContainText('Leave');
  // the store keeper: Transfers is a tab of RFMs, and no longer one of Stock's
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto('/requests');
  await page.getByTestId('tab-transfers').click();
  await page.waitForURL('**/stock/transfers**');
  await expect(page.getByTestId('tab-transfers')).toHaveAttribute('aria-current', 'page');
  await page.goto('/stock');
  await expect(page.getByRole('navigation', { name: 'Stock tabs' })).not.toContainText('Transfers');
});

test('one request, one screen: every link to it opens the ask, with the buttons there (ADR 147)', async ({
  page,
}) => {
  await stockAtMain('Test Bath Towel', 400);
  // the attendant asks for more than housekeeping has
  await signInAs(page, 'Test Room Attendant 1.0');
  await page.goto('/requests?tab=ask');
  const towel = page.getByRole('listitem').filter({ hasText: 'Test Bath Towel' });
  await towel.getByRole('textbox').fill('300');
  await page.getByRole('button', { name: 'Request 1 item' }).click();
  await page.waitForURL(/\/stock\/asks\/[0-9a-f-]{36}/);
  const ask = new URL(page.url()).pathname.split('/').pop()!;

  // the head is short and requests it from the Main Store
  await signInAs(page, 'Test Executive Housekeeper 1.0');
  await page.goto(`/stock/asks/${ask}`);
  await page.getByRole('button', { name: 'Short: request it' }).click();
  await expect(page.getByTestId('request-now')).toHaveAttribute('data-stage', 'asked_on');
  const [t] = await asMigrator<{ id: string; progress: string }>(
    `select t.id::text, s.progress from inv.transfer t
       join inv.transfer_summary s on s.id = t.id where t.for_ask_id = $1`,
    [ask],
  );
  expect(t).toBeTruthy();

  // whoever approves or sends it opens the request and lands on the ask, its buttons there
  if (t!.progress === 'awaiting_approval') {
    await signInAs(page, 'Test General Manager 1.0');
    await page.goto(`/stock/transfers/${t!.id}`);
    await page.waitForURL(`**/stock/asks/${ask}`);
    await expect(page.getByTestId('ask-lines')).toContainText('Test Bath Towel');
    await page.getByRole('button', { name: 'Approve' }).click();
    await runExecutor();
  }
  await signInAs(page, 'Test Store Keeper 1.0');
  await page.goto(`/stock/transfers/${t!.id}`);
  await page.waitForURL(`**/stock/asks/${ask}`);
  await expect(page.getByTestId('sender-tools')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Send Test Bath Towel' }).fill('300');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await runExecutor();

  // the head opens it from RFMs → History: the same screen, receive and then give it there
  await signInAs(page, 'Test Executive Housekeeper 1.0');
  await page.goto('/requests?tab=history');
  await page
    .getByTestId('request-item')
    .filter({ hasText: '300 × Test Bath Towel' })
    .first()
    .getByRole('link')
    .first()
    .click();
  await page.waitForURL(`**/stock/asks/${ask}`);
  await page.getByRole('button', { name: 'Everything arrived' }).click();
  await page.getByRole('button', { name: 'Transfer to Housekeeping done' }).click();
  await expect(page.getByRole('button', { name: 'It arrived: give it' })).toBeVisible();
});
