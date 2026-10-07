import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { placeId, signInAs } from './helpers';

// Admin → Who does what (ADR 065) at 380 px: the two common cases, as the Account Owner and
// as a GM who is the user admin of one outlet. Every cover a test sets is put back in a
// finally block, so the other specs see the seed's state (no covers). Who may do what, and
// what moves, is proved in packages/db/src/who-does-what.db.test.ts.

test.use({ viewport: { width: 380, height: 800 } });

/** Archives the covers these tests set and applies access there again, as the seed has it. */
async function putBack(outlets: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await client.connect();
  try {
    for (const code of outlets) {
      const id = await placeId(code);
      await client.query(
        `update hr.role_cover set archived_at = now() where org_node_id = $1 and archived_at is null`,
        [id],
      );
      await client.query('select core.apply_cover_access($1)', [id]);
    }
  } finally {
    await client.end();
  }
}

async function openRole(page: Page, outlet: string, role: string): Promise<void> {
  await page.goto('/admin/cover');
  await page.getByLabel('Place').selectOption({ label: outlet });
  await page.locator(`[data-testid="cover-role"][data-role="${role}"] a`).click();
}

test('"Our Sous Chef left; the Executive Chef covers", then back', async ({ page }) => {
  try {
    await signInAs(page, 'Test Account Owner');
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Who does what' }).click();
    await expect(page.getByLabel('Place')).toHaveValue('all');
    await expect(page.getByText('At every outlet, each role')).toBeVisible();

    await openRole(page, 'Test Hotel & Bar 1.1', 'SOUS_CHEF');
    await expect(page.getByRole('heading', { name: 'Sous Chef' })).toBeVisible();
    await expect(page.getByTestId('cover-now')).toHaveText('We have it · 1 person');
    await page.getByLabel('Someone else does it').check();
    await page
      .getByLabel('Which role does it')
      .selectOption({ label: 'Executive Chef (1 person)' });
    await expect(page.getByTestId('cover-sentence')).toHaveText(
      "The Executive Chef does the Sous Chef's work here: leads the shift, works shifts in the " +
        "department and uses the department's store. Its tasks go to the Executive Chef on duty.",
    );
    // the outlet still has a Sous Chef: the same warning file 37 gives
    await expect(page.getByTestId('cover-warning')).toHaveText([
      'Test Hotel & Bar 1.1 has 1 Sous Chef: they and every Executive Chef there will share its work.',
    ]);
    await expect(page.getByTestId('cover-outcome')).toContainText(
      'Their access changes at once: Test Executive Chef 1.1.',
    );
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Saved. Access changed at once for 1 person.',
    );
    await expect(page.getByTestId('cover-now')).toHaveText('Someone else does it: Executive Chef');

    // "All outlets" now lists it
    await page.goto('/admin/cover');
    await expect(page.getByTestId('cover-role')).toHaveCount(1);
    await expect(page.getByTestId('cover-role')).toContainText('Sous Chef · Test Hotel & Bar 1.1');
    await expect(page.getByTestId('cover-answer')).toHaveText(
      'Someone else does it: Executive Chef',
    );

    // and back: the Sous Chef does it again
    await page.getByTestId('cover-role').getByRole('link').click();
    await page.getByLabel('We have it').check();
    await expect(page.getByTestId('cover-sentence')).toContainText(
      'The Executive Chef stops covering; the Sous Chef does this work again',
    );
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Saved. Access changed at once for 1 person.',
    );
    await expect(page.getByTestId('cover-now')).toHaveText('We have it · 1 person');
  } finally {
    await putBack(['TEST-HOTEL-1.1']);
  }
});

test('a GM who is a user admin: only their outlet, and never their own access', async ({
  page,
}) => {
  try {
    await signInAs(page, 'Test General Manager 1.0');
    await page.goto('/admin/cover');
    // one outlet: no picker, every role there
    await expect(page.getByTestId('viewing')).toHaveText('Test Hotel & Bar 1.0');
    await expect(page.locator('[data-role="GENERAL_MANAGER"]')).toBeVisible();
    await expect(page.locator('[data-role="AREA_MANAGER"]')).toHaveCount(0);
    await page.locator('[data-testid="cover-role"][data-role="STORE_KEEPER"] a').click();
    await page.getByLabel('Someone else does it').check();
    await page
      .getByLabel('Which role does it')
      .selectOption({ label: 'General Manager (1 person)' });
    await expect(page.getByTestId('cover-error')).toHaveText(
      "You can't change your own access. Ask another administrator.",
    );
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    // "We hired a Store Keeper; stop the GM covering": the Account Owner sets it, then ends it
    await signInAs(page, 'Test Account Owner');
    await openRole(page, 'Test Hotel & Bar 1.0', 'STORE_KEEPER');
    await page.getByLabel('Someone else does it').check();
    await page
      .getByLabel('Which role does it')
      .selectOption({ label: 'General Manager (1 person)' });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('cover-now')).toHaveText('Someone else does it: General Manager');
    await page.getByLabel('We have it').check();
    await expect(page.getByTestId('cover-sentence')).toHaveText(
      'The General Manager stops covering; the Store Keeper does this work again: works shifts ' +
        'in the department and keeps the Main Store.',
    );
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Saved.');
    await expect(page.getByTestId('cover-now')).toHaveText('We have it · 1 person');
  } finally {
    await putBack(['TEST-HOTEL-1.0']);
  }
});
