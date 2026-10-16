import { expect, test } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Menu, recipes and costs (ADR 014): staff read the recipes made or sold where they work,
// without a cost anywhere; managers see cost per serve and cost %, and change recipes and
// prices as new versions from a date.

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function recipeId(sku: string): Promise<string> {
  const rows = await asMigrator<{ id: string }>(
    `select r.id from inv.recipe r join inv.item i on i.id = r.prep_item_id
       join core.tenant t on t.id = r.tenant_id
      where t.code = 'TEST-COMPANY' and i.sku = $1 and r.effective_to is null`,
    [sku],
  );
  return rows[0]!.id;
}

test('a sous chef reads the kitchen’s recipes and procedures and the bar’s', async ({ page }) => {
  // the whole outlet's menu (ADR 165); costs stay with the kitchen's managers (ADR 123)
  await signInAs(page, 'Test Sous Chef 1.0');
  await page.goto('/menu/recipes');
  await expect(page.locator('[data-code="GINGER-GARLIC-PASTE"]')).toBeVisible();
  await expect(page.locator('[data-code="NEGRONI-BATCH"]')).toBeVisible();

  await page.locator('[data-code="GINGER-GARLIC-PASTE"] a').click();
  await expect(page.getByTestId('recipe-name')).toHaveText('Ginger Garlic Paste');
  await expect(page.getByTestId('batch')).toContainText('1,000 g');
  await expect(page.getByTestId('allergens')).toHaveText('No allergens declared');
  // the method is the Recipe tab (ADR 078)
  await expect(page.getByTestId('step')).toHaveCount(0);
  await page.getByTestId('tab-recipe').click();
  await expect(page.getByTestId('step').first()).toBeVisible();
});

test('a commis, a bartender and a steward read the menu with no ₹ anywhere', async ({ page }) => {
  // everyone in a kitchen, bar or restaurant knows the menu, never its money (ADR 165)
  for (const who of ['Test Commis 1.0', 'Test Bartender 1.0', 'Test Steward 1.0']) {
    await signInAs(page, who);
    await page.goto('/menu');
    const main = page.locator('main');
    await expect(main.getByRole('heading', { name: 'Recipes' }), who).toBeVisible();
    for (const code of ['BUTTER-CHICKEN', 'MOJITO', 'GINGER-GARLIC-PASTE']) {
      await expect(
        page.locator(`[data-testid="recipe-row"][data-code="${code}"]`),
        who,
      ).toBeVisible();
    }
    await expect(main, who).not.toContainText('₹');
    await expect(main.getByRole('link', { name: 'Menu costs' }), who).toHaveCount(0);

    await page.goto(`/menu/recipes/${await recipeId('GINGER-GARLIC-PASTE')}`);
    await expect(page.getByTestId('recipe-name'), who).toHaveText('Ginger Garlic Paste');
    await expect(page.getByTestId('recipe-line').first(), who).toBeVisible();
    await expect(page.getByTestId('line-cost'), who).toHaveCount(0);
    await expect(page.getByTestId('recipe-total'), who).toHaveCount(0);
    await expect(main, who).not.toContainText('Costs at');
    await expect(main, who).not.toContainText('₹');
    await page.getByTestId('tab-recipe').click();
    await expect(page.getByTestId('step').first(), who).toBeVisible();
    await expect(main.getByRole('link', { name: 'Change recipe' }), who).toHaveCount(0);
  }
});

test('a room attendant has no menu at all', async ({ page }) => {
  await signInAs(page, 'Test Room Attendant 1.0');
  await page.goto('/');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Menu' }),
  ).toHaveCount(0);
  await page.goto('/menu');
  await expect(page.locator('main')).toContainText('No recipes are made or sold where you work.');
});

test('the general manager sees cost %, sets a price from tomorrow, and cannot change a recipe shared with another hotel', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/menu');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Menu costs' })).toBeVisible();
  const row = page.locator('[data-testid="menu-row"][data-code="BUTTER-CHICKEN"]');
  await expect(row.getByTestId('cost-pct')).toHaveText(/^\d+\.\d%$/);

  await row.getByRole('link').click();
  await expect(page.getByTestId('recipe-name')).toHaveText('Butter Chicken');
  // what the dish carries comes from its ingredients, the makhani gravy's too (ADR 138)
  await expect(page.getByTestId('allergens')).toHaveText('Contains milk');
  await expect(page.getByTestId('line-cost').first()).toBeVisible();
  await expect(page.getByTestId('recipe-total')).toContainText('Cost per serve');

  await main.getByRole('textbox', { name: 'Price before tax (₹)' }).fill('505');
  await main.getByLabel('From').fill(tomorrow());
  await main.getByRole('button', { name: 'Save price' }).click();
  await expect(main.getByRole('status')).toHaveText(`Price saved from ${tomorrow()}.`);

  // Butter Chicken is also sold at Hotel 1.1: beyond one hotel's manager
  await main.getByRole('link', { name: 'Change recipe' }).click();
  await main.getByRole('textbox', { name: 'Quantity 1' }).fill('260');
  await main.getByLabel('In use from').fill(tomorrow());
  await main.getByRole('button', { name: 'Save new version' }).click();
  await expect(main.getByRole('alert')).toHaveText("You don't have access to do that.");
});

test('a standalone bar’s manager changes a recipe from tomorrow', async ({ page }) => {
  await signInAs(page, 'Test Bar Manager');
  await page.goto('/menu');
  const main = page.locator('main');
  await page.locator('[data-testid="menu-row"][data-code="MOJITO"] a').click();
  await expect(page.getByTestId('recipe-name')).toHaveText('Mojito');
  await main.getByRole('link', { name: 'Change recipe' }).click();
  const qty = main.getByRole('textbox', { name: 'Quantity 1' });
  const before = Number(await qty.inputValue());
  await qty.fill(String(before + 5));
  await main.getByLabel('In use from').fill(tomorrow());
  await main.getByRole('button', { name: 'Save new version' }).click();
  // back on today's version, which is unchanged until tomorrow
  await expect(page.getByTestId('recipe-name')).toHaveText('Mojito');
  const rows = await asMigrator<{ n: number }>(
    `select count(*)::int as n from inv.recipe r join menu.menu_item m on m.id = r.menu_item_id
       join core.tenant t on t.id = m.tenant_id
      where t.code = 'TEST-SOLO-COMPANY' and m.code = 'MOJITO' and r.effective_from = $1::date`,
    [tomorrow()],
  );
  expect(rows[0]!.n).toBe(1);
});

test("a dish: Ingredients, where a prep item opens its own recipe, and Recipe, the dish's method", async ({
  page,
}) => {
  // ADR 078: Test Company's Butter Chicken has a method in file 24; its makhani gravy is a
  // prep item. The GM reads both; no ₹ on the Recipe tab.
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/menu/recipes');
  await page.locator('[data-code="BUTTER-CHICKEN"] a').click();
  await expect(page.getByTestId('recipe-name')).toHaveText('Butter Chicken');
  await expect(page.getByTestId('tab-ingredients')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('recipe-line')).toHaveCount(5);
  await page.getByTestId('tab-recipe').click();
  await expect(page.getByTestId('step')).toHaveCount(3);
  await expect(page.getByTestId('step').first()).toContainText('Warm 200 g makhani gravy');
  await page.getByTestId('tab-ingredients').click();
  await page.getByTestId('sub-recipe').filter({ hasText: 'Makhani Gravy' }).click();
  await expect(page.getByTestId('recipe-name')).toHaveText('Makhani Gravy');
  await expect(page.getByTestId('tab-recipe')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('step').first()).toContainText('Blanch, peel');
});
