import { expect, test } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// The rooms' minibars (ADR 072, 081) at 380 px. Test Hotel & Bar 1.0's room attendant checks
// room 103: one cola is gone, so it is charged; the refill is on the attendant's To do list and
// the bill on the front desk's. The attendant refills it from the Bar Store; the front desk
// marks it added to the bill, which closes its task. Who may, and what the database refuses,
// is proved in packages/db/src/minibar.db.test.ts. The cola taken from the store is put back.

test.use({ viewport: { width: 380, height: 900 } });

test('the room attendant checks a minibar; the front desk adds it to the bill', async ({
  page,
}) => {
  const started = new Date().toISOString();
  try {
    await signInAs(page, 'Test Room Attendant 1.0');
    await page.goto('/me');
    await page.getByTestId('me-minibar').click();
    await page.waitForURL(/\/minibar$/);
    await expect(page.getByTestId('minibar-summary')).toContainText('rooms checked today');
    await page.getByTestId('minibar-room').filter({ hasText: 'Room 103' }).click();
    await page.waitForURL(/\/minibar\/[0-9a-f-]{36}$/);

    const form = page.getByRole('form', { name: 'Minibar check' });
    // nothing is filled in: saving now asks for every count
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toContainText('Count every item');
    await form.getByRole('button', { name: 'All there: nothing used' }).click();
    await form.getByLabel('Left: Test Cola 300ml').fill('1');
    await expect(form.getByTestId('minibar-charge-preview')).toHaveText('To charge: ₹120.00');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toContainText("Saved. ₹120.00 to add to the guest's bill");
    await expect(page.getByTestId('minibar-history')).toContainText('Test Cola 300ml ×1');

    // the refill is the attendant's To do item: refilled from the Bar Store
    await page.goto('/tasks');
    await page
      .getByRole('link', { name: /Refill minibar, room 103/ })
      .first()
      .click();
    await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('task-title')).toHaveText('Refill minibar, room 103');
    await expect(page.getByTestId('minibar-used')).toContainText('1 Test Cola 300ml');
    await page.getByRole('button', { name: 'Refilled' }).click();
    await expect(page.getByTestId('task-status')).toContainText(/done/i);

    await signInAs(page, 'Test Front Desk Executive 1.0');
    // the bill is a To do item for the front desk too
    await page.goto('/tasks');
    await expect(
      page.getByRole('link', { name: /Bill room 103: 1 Test Cola 300ml/ }).first(),
    ).toBeVisible();
    await page.goto('/minibar?tab=charge');
    const charge = page.getByTestId('minibar-charge').filter({ hasText: 'Room 103' });
    await expect(charge).toContainText('₹120.00');
    await charge.getByRole('button', { name: 'Added to the bill' }).click();
    await expect(page.getByTestId('minibar-charge').filter({ hasText: 'Room 103' })).toHaveCount(0);
  } finally {
    // put back what the refill took from the bar store
    await asMigrator(
      `select inv.post(l.item_id, c.store_id, 'count_adjust', l.refilled_qty, l.unit_cost,
                       'e2e-undo', c.id)
         from ops.minibar_check c join ops.minibar_check_line l on l.check_id = c.id
        where c.created_at >= $1 and l.refilled_qty > 0`,
      [started],
    );
  }
});
