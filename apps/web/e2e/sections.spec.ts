import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// Floor sections (ADR 133) at 380 px on Test Hotel 1.0's restaurant (file 47: Section 1 to 3):
// its manager gives sections from Home, a row per person like the roster, confirmed with Save
// changes, and the steward sees theirs on Home. Who may
// give sections is proved in packages/db/src/sections.db.test.ts.

test.use({ viewport: { width: 380, height: 900 } });

const main = (page: Page) => page.locator('main');

test('the restaurant manager gives Section 2; the steward sees it on Home', async ({ page }) => {
  const dept = await placeId('TEST-HOTEL-1.0-RESTAURANT');
  try {
    await signInAs(page, 'Test Restaurant Manager 1.0');
    await page.goto('/');
    await main(page).getByTestId('home-give-sections').click();
    await page.waitForURL(/\/sections\/give/);
    // a row per person, like the roster: a tap marks it, Save changes saves it
    const row = (name: string) => main(page).getByTestId('person-row').filter({ hasText: name });
    const tile = (name: string, section: string) =>
      row(name).getByRole('button', { name: new RegExp(`^${section}`) });
    const save = main(page).getByTestId('save-sections');
    await expect(save).toBeDisabled();
    await tile('Test Steward 1.0', 'Section 2').click();
    await tile('Test Steward 1.0', 'Section 3').click();
    await expect(tile('Test Steward 1.0', 'Section 2')).toHaveAttribute('aria-pressed', 'true');
    await expect(save).toHaveText('Save changes (2)');
    // Undo puts it back as it was
    await main(page).getByRole('button', { name: 'Undo' }).click();
    await expect(tile('Test Steward 1.0', 'Section 2')).toHaveAttribute('aria-pressed', 'false');
    await expect(save).toBeDisabled();
    // two sections for one steward, then one moved to another
    await tile('Test Steward 1.0', 'Section 2').click();
    await tile('Test Steward 1.0', 'Section 3').click();
    await expect(tile('Test Steward B 1.0', 'Section 3')).toHaveAccessibleName(/Test's/);
    await tile('Test Steward B 1.0', 'Section 3').click();
    await expect(tile('Test Steward 1.0', 'Section 3')).toHaveAttribute('aria-pressed', 'false');
    await save.click();
    await expect(main(page).getByRole('status')).toContainText('Saved');
    // it stays after a reload: it was saved
    await page.reload();
    await expect(tile('Test Steward 1.0', 'Section 2')).toHaveAttribute('aria-pressed', 'true');
    await expect(tile('Test Steward B 1.0', 'Section 3')).toHaveAttribute('aria-pressed', 'true');

    await signInAs(page, 'Test Steward 1.0');
    await page.goto('/');
    const card = main(page).getByTestId('home-sections');
    await expect(card).toContainText('Your section today');
    await expect(card).toContainText('Section 2');
    // a steward does not give sections
    await expect(card.getByTestId('home-give-sections')).toHaveCount(0);
  } finally {
    await asMigrator(`delete from ops.section_assignment where org_node_id = $1`, [dept]);
  }
});
