import { expect, test } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Customer-specific access groups (AC-1, ADR 027). The Account Owner builds a group from
// the product's rights, and it can carry a role's requests and approvals. Test Company's
// Kitchen Lead (file 05) is held by Sous Chef 1.1 at Hotel 1.1's kitchen and approves like
// its department head.

test.afterAll(async () => {
  // the group this spec builds, if a run stopped half way
  await asMigrator(
    `delete from core.domain_policy dp using core.security_group g
      where g.id = dp.group_id and g.code = 'E2E_BAR_LEAD';
     update core.security_group set archived_at = now()
      where code = 'E2E_BAR_LEAD' and archived_at is null`,
    [],
  );
});

test('the owner builds a group, it can be given to people, and removed while unused', async ({
  page,
}) => {
  await signInAs(page, 'Test Account Owner');
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Access groups' }).click();
  await expect(page.getByTestId('custom-groups')).toContainText('Kitchen Lead');
  await page.getByRole('link', { name: 'New group' }).click();

  const form = page.getByRole('form', { name: 'Access group' });
  await form.getByLabel('Name').fill('E2E Bar lead');
  await expect(form.getByTestId('group-code')).toHaveText('Code E2E_BAR_LEAD');
  await form.getByLabel('rosters', { exact: true }).selectOption('modify');
  await form.getByLabel('tasks', { exact: true }).selectOption('modify');
  await form.getByLabel('Department Head').check();
  await form.getByRole('button', { name: 'Create group' }).click();
  await page.waitForURL('**/admin/groups');
  const row = page.locator('[data-group="E2E_BAR_LEAD"]');
  await expect(row).toContainText('Change: rosters, tasks');
  await expect(row).toContainText('Requests and approvals like: Department Head');
  await expect(row).toContainText('0 people');

  // a product group's name can't be taken
  await page.getByRole('link', { name: 'New group' }).click();
  await form.getByLabel('Name').fill('Staff');
  await expect(form.getByTestId('group-code')).toContainText('is a product group');
  await expect(form.getByRole('button', { name: 'Create group' })).toBeDisabled();

  // it is in the list of access a user admin can give
  const person = await asMigrator<{ id: string }>(
    `select id from core.app_user where username = 'test.bartender.1.0'`,
    [],
  );
  await page.goto(`/admin/users/${person[0]!.id}`);
  const add = page.getByRole('form', { name: 'Add access' });
  await expect(add.getByLabel('Access').locator('option', { hasText: 'E2E Bar lead' })).toHaveCount(
    1,
  );

  // unused, so it can be removed (asked first)
  await page.goto('/admin/groups/E2E_BAR_LEAD');
  await page.getByRole('button', { name: 'Remove group' }).click();
  await page
    .getByRole('group', { name: 'Remove group' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await page.waitForURL('**/admin/groups');
  await expect(page.locator('[data-group="E2E_BAR_LEAD"]')).toHaveCount(0);
});

test('a user admin sees the groups but cannot build or change them', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/admin/groups');
  const kitchen = page.locator('[data-group="KITCHEN_LEAD"]');
  await expect(kitchen).toContainText('1 person');
  await expect(kitchen).toContainText('Requests and approvals like: Department Head');
  await expect(kitchen.getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New group' })).toHaveCount(0);
  await page.goto('/admin/groups/new');
  await expect(page.getByText('Only the account owner can build access groups.')).toBeVisible();
});

test("Kitchen Lead approves the 1.1 kitchen's leave from Inbox, like its department head", async ({
  page,
}) => {
  // the commis asks for a day far enough out to touch no shift (once per database)
  await asMigrator(
    `with me as materialized (
       select set_config('app.user_id', u.id::text, true) as s
         from core.app_user u where u.username = 'test.commis.1.1')
     select hr.request_leave(t.id, current_date + 170, current_date + 170, 'custom groups')
       from me, hr.leave_type t join core.tenant te on te.id = t.tenant_id
      where te.code = 'TEST-COMPANY' and t.code = 'UNPAID_LEAVE'
        and not exists (select 1 from hr.leave_request l
                         where l.owner_user_id = (select id from core.app_user
                                                   where username = 'test.commis.1.1')
                           and l.from_date = current_date + 170 and l.status <> 'cancelled')`,
    [],
  );
  await signInAs(page, 'Test Sous Chef 1.1');
  await page.goto('/inbox');
  const item = page
    .getByTestId('inbox-item')
    .filter({ hasText: 'Test Commis 1.1' })
    .filter({ hasText: 'Leave' });
  await item.getByRole('link', { name: 'Review' }).first().click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toHaveText('Approved');
});
