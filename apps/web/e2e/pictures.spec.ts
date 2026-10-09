import { expect, test, type Page } from '@playwright/test';
import { asMigrator, placeId, signInAs } from './helpers';

// A picture of the thing itself on every item line, how many portions a batch makes, and a
// task's photos above the button that finishes it (ADR 084), at 380 px, as the commis who
// makes, the chef who gives out the prep and the store keeper who counts.

test.use({ viewport: { width: 380, height: 900 } });

const pictures = async (page: Page, row: string) =>
  page
    .getByTestId(row)
    .evaluateAll((rows) =>
      rows.map(
        (r) =>
          r.querySelector('[data-testid="item-picture"]')?.getAttribute('data-picture') ?? null,
      ),
    );

test('a commis making mint chutney sees each ingredient, how many it makes, and photos before Record the batch', async ({
  page,
}) => {
  const [task] = await asMigrator<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, due_at,
                           assign_mode, assignee_user_id, item_id, target_qty)
     select n.tenant_id, ops.team_of_store(n.id), n.id, 'prep', 'Make Mint Chutney',
            now() + interval '3 hours', 'person', u.id, i.id, 250
       from core.hierarchy_node n
       join core.app_user u on u.username = 'test.commis.1.0'
       join inv.item i on i.tenant_id = n.tenant_id and i.sku = 'MINT-CHUTNEY'
      where n.code = 'TEST-HOTEL-1.0-KITCHEN-STORE'
     returning id`,
    [],
  );
  await asMigrator(
    `insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind)
     select tenant_id, id, org_node_id, 1, 'Record the batch', 'batch' from ops.task where id = $1`,
    [task!.id],
  );
  // a photo taken on it earlier (cleared since), so the Photos section shows without storage
  await asMigrator(
    `insert into ops.task_photo (tenant_id, task_id, org_node_id, photo_key, taken_by, taken_at,
                                 purged_at)
     select t.tenant_id, t.id, t.org_node_id, null, t.assignee_user_id, now(), now()
       from ops.task t where t.id = $1`,
    [task!.id],
  );
  try {
    await signInAs(page, 'Test Commis 1.0');
    await page.goto(`/tasks/${task!.id}`);
    // a 500 g batch makes 20 portions: 250 g makes 10
    await expect(page.getByTestId('prep-portions')).toHaveText('Makes about 10 portions');
    const shown = await pictures(page, 'prep-ingredient');
    expect(shown.length).toBeGreaterThan(1);
    expect(shown).toContain('mint');
    expect(shown.filter((k) => k === null || k === 'box')).toEqual([]);
    // the photos are part of doing it: above the button that finishes it, headed plainly
    const photos = page.getByTestId('task-photos');
    await expect(photos.getByRole('heading')).toHaveText('Photos');
    const record = page.locator('main').getByRole('button', { name: 'Record the batch' });
    const [p, r] = [await photos.boundingBox(), await record.boundingBox()];
    expect(p!.y).toBeLessThan(r!.y);
  } finally {
    await asMigrator(`delete from ops.task_photo where task_id = $1`, [task!.id]);
    await asMigrator(`update ops.task set status = 'cancelled' where id = $1`, [task!.id]);
  }
});

test('the prep list gives each name its own line, with its picture', async ({ page }) => {
  const store = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/tasks/prep?node=${store}`);
  const line = page.getByTestId('prep-line').filter({ hasText: 'Mint Chutney' });
  await expect(line.getByTestId('item-picture')).toHaveAttribute('data-picture', 'chutney');
  // the name is never squeezed into one word a line by the quantity box
  const name = line.getByText('Mint Chutney', { exact: true });
  // boundingBox does not wait: measure once it is shown
  await expect(name).toBeVisible();
  expect((await name.boundingBox())!.width).toBeGreaterThan(80);
  expect((await name.boundingBox())!.height).toBeLessThan(30);
  const box = line.getByRole('textbox', { name: /^Make Mint Chutney/ });
  await expect(box).toBeVisible();
  expect((await box.boundingBox())!.width).toBeLessThan(140);
});

test("a recipe says how many portions a batch makes, and shows each ingredient's picture", async ({
  page,
}) => {
  await signInAs(page, 'Test Commis 1.0');
  await page.goto('/menu/recipes');
  await page
    .getByRole('link', { name: /Mint Chutney/ })
    .first()
    .click();
  await expect(page.getByTestId('portions')).toHaveText('about 20 portions');
  const shown = await pictures(page, 'recipe-line');
  expect(shown).toContain('mint');
  expect(shown.filter((k) => k === null || k === 'box')).toEqual([]);
});

test('every stock line is matched to the picture of the thing itself', async ({ page }) => {
  const store = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock?node=${store}`);
  const rows = page.locator('main li').filter({ has: page.getByTestId('item-picture') });
  await expect(rows.first()).toBeVisible();
  const keys = await page
    .getByTestId('item-picture')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-picture')));
  expect(keys).toContain('garlic');
  expect(keys.filter((k) => k === 'box')).toEqual([]);
});

test('an item shows a real photo from our library, and Profile credits it (ADR 086)', async ({
  page,
}) => {
  const store = await placeId('TEST-HOTEL-1.0-KITCHEN-STORE');
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto(`/stock?node=${store}`);
  const garlic = page.locator('[data-testid="item-picture"][data-picture="garlic"] img').first();
  await expect(garlic).toHaveAttribute('src', '/pictures/garlic.webp');
  await expect
    .poll(() => garlic.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  await page.goto('/profile');
  await page.getByRole('link', { name: 'Picture credits' }).click();
  const row = page.locator('main li').filter({ hasText: 'Garlic' }).first();
  await expect(row.getByRole('link', { name: /Commons|source/i }).first()).toHaveAttribute(
    'href',
    /^https:\/\/commons\.wikimedia\.org\//,
  );
});
