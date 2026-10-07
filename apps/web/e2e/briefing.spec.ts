import { expect, test } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Today's briefing (ADR 070) at 380 px. The Head Cook writes the kitchen's note from Home,
// with a dish that is off; a server at the same outlet reads it on Home and cannot edit it;
// someone at another outlet sees nothing of it. Who may write and read is proved in
// packages/db/src/briefing.db.test.ts (the person covering a writer included). The notes
// written here are taken down in a finally block.

test.use({ viewport: { width: 380, height: 900 } });

test('the head cook writes the briefing; the outlet reads it on Home', async ({ page }) => {
  const started = new Date().toISOString();
  const { dish } = (
    await asMigrator<{ dish: string }>(
      `select mi.name as dish from menu.menu_outlet mo
         join menu.menu_item mi on mi.id = mo.menu_item_id
         join core.hierarchy_node o on o.id = mo.org_node_id
        where o.code = 'TEST-BAR-3.0' and mi.archived_at is null
          and mo.effective_from <= rpt.today(o.id)
          and (mo.effective_to is null or mo.effective_to >= rpt.today(o.id))
        order by mi.name limit 1`,
      [],
    )
  )[0]!;
  try {
    await signInAs(page, 'Test Head Cook 3.0');
    await page.goto('/');
    const card = page.getByTestId('briefing');
    await expect(card).toContainText('Nothing written for today yet.');
    await card.getByRole('link', { name: "Write today's briefing" }).click();
    await page.waitForURL(/\/briefing$/);

    const form = page.getByRole('form', { name: 'Briefing' });
    await expect(form.getByRole('radio', { name: 'Whole day' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // nothing to share yet
    await form.getByRole('button', { name: 'Share with the team' }).click();
    await expect(form).toContainText('Write something, or pick the dishes that are off today.');

    await form
      .getByLabel('What the team should know')
      .fill('Fish special tonight. Table 4 is nut-free.');
    await form.getByLabel('Find a dish').fill(dish.slice(0, 5));
    await form
      .getByRole('button', { name: new RegExp(`^${dish.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
      .first()
      .click();
    await expect(form.getByTestId('off-dishes')).toContainText(dish);
    await form.getByRole('button', { name: 'Share with the team' }).click();
    await expect(form).toContainText('Saved. Everyone at the outlet sees it on Home.');
    await expect(form.getByRole('button', { name: 'Save changes' })).toBeVisible();

    // on their own Home: the note, with Edit
    await page.goto('/');
    const mine = page.getByTestId('briefing-note');
    await expect(mine).toContainText('From Kitchen');
    await expect(mine).toContainText('Fish special tonight.');
    await expect(mine.getByTestId('briefing-off')).toHaveText(`Off today: ${dish}`);
    await expect(mine.getByRole('link', { name: 'Edit' })).toBeVisible();

    // a server at the same outlet reads it, and cannot edit or write
    await signInAs(page, 'Test Server 3.0');
    await page.goto('/');
    const theirs = page.getByTestId('briefing');
    await expect(theirs.getByTestId('briefing-note')).toContainText('Fish special tonight.');
    await expect(theirs.getByTestId('briefing-off')).toHaveText(`Off today: ${dish}`);
    await expect(theirs.getByRole('link')).toHaveCount(0);
    await page.goto('/briefing');
    await expect(page.getByText("You don't write the briefing anywhere.")).toBeVisible();

    // someone at another outlet sees nothing of it
    await signInAs(page, 'Test Chef de Partie 1.1');
    await page.goto('/');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('briefing')).toHaveCount(0);
  } finally {
    await asMigrator(
      `update ops.briefing set archived_at = now()
        where archived_at is null and created_at >= $1
          and outlet_id = (select id from core.hierarchy_node where code = 'TEST-BAR-3.0')`,
      [started],
    );
  }
});
