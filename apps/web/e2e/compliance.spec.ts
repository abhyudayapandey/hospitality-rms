import { expect, test } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Compliance (ADR 069) at 380 px. Test Company has the bundle in its plan (seed/dev/002); its
// files 38 and 39 give Hotel 1.0 an expired FSSAI licence and an overdue pest control
// service. The owner finds both on Home and lands on the matching tab; a renewal needs the
// renewed licence; a job that needs no report is marked done and its next due date moves on
// (put back afterwards). Test Solo Bar Co. hasn't bought it. Who may do what is proved in
// packages/db/src/compliance.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const GM = 'Test General Manager 1.0';

test('the owner: Home names the overdue job and the expiring licence; each opens its tab', async ({
  page,
}) => {
  // the GM's five lines are already full (a late renewal also counts as a late task), so
  // the owner, who sees every outlet's licences, finds them on Home
  await signInAs(page, 'Test Account Owner');
  const first = page.getByTestId('dofirst-card');
  await first.getByRole('link', { name: /1 compliance job overdue/ }).click();
  await page.waitForURL(/\/compliance\?.*tab=overdue/);
  await expect(page.getByRole('link', { name: /^Overdue/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByTestId('job')).toHaveCount(1);
  await expect(page.getByTestId('job')).toHaveAttribute('data-name', 'Pest control service');
  await expect(page.getByTestId('job-status')).toContainText('Overdue');

  await page.goto('/');
  await first.getByRole('link', { name: /1 licence expiring/ }).click();
  await page.waitForURL(/\/compliance\?.*tab=expiring/);
  await expect(page.getByTestId('licence')).toHaveCount(1);
  await expect(page.getByTestId('licence')).toHaveAttribute('data-name', 'FSSAI licence');
  await expect(page.getByTestId('licence-status')).toContainText('Expired');
});

test('the GM: a renewal needs the renewed licence; nothing changes without it', async ({
  page,
}) => {
  await signInAs(page, GM);
  await page.goto('/compliance?tab=licences');
  await page.getByTestId('licence').filter({ hasText: 'FSSAI licence' }).getByRole('link').click();
  await page.waitForURL(/\/compliance\/licences\//);
  const renew = page.getByRole('form', { name: 'Renew the licence' });
  await renew.getByLabel('New expiry').fill('2031-01-31');
  await renew.getByRole('button', { name: 'Save the renewal' }).click();
  await expect(renew.getByRole('alert')).toContainText('Add the document');
  await expect(page.getByTestId('licence-status')).toContainText('Expired');
});

test('the GM: a job with no report needed is marked done; its next due date moves on', async ({
  page,
}) => {
  const [job] = await asMigrator<{ id: string; next_due: string }>(
    `select id, next_due::text from ops.compliance_item where name = 'Lift rescue drill'`,
    [],
  );
  try {
    await signInAs(page, GM);
    await page.goto(`/compliance/calendar/${job!.id}`);
    const done = page.getByRole('form', { name: 'Mark it done' });
    // no photo bucket here: nothing to add, and none needed
    await expect(done).not.toContainText('needed');
    await done.getByRole('button', { name: 'Mark done' }).click();
    await expect(done.getByRole('status')).toContainText('Done. Next due');
    await expect(page.getByTestId('job-history')).toBeVisible();
    const [after] = await asMigrator<{ next_due: string }>(
      `select next_due::text from ops.compliance_item where id = $1`,
      [job!.id],
    );
    expect(after!.next_due).not.toBe(job!.next_due);
  } finally {
    await asMigrator(`delete from ops.compliance_done where item_id = $1`, [job!.id]);
    await asMigrator(`update ops.compliance_item set next_due = $2::date where id = $1`, [
      job!.id,
      job!.next_due,
    ]);
  }
});

test("a customer without the bundle: Compliance isn't part of its plan", async ({ page }) => {
  await signInAs(page, 'Test Bar Manager');
  await page.goto('/compliance');
  await expect(page.getByTestId('module-off')).toContainText(
    "Compliance isn't part of your company's plan. Ask Outlet Ops to add it.",
  );
});
