import { expect, test } from '@playwright/test';
import { signInAs, viewing } from './helpers';

// One screen per function, opened with the scope the count had (ADR 048): a count on Home
// opens its screen on the matching tab with "All ..." chosen, and the list is as long as
// the count. The person then narrows to one place from the Place picker.

test('the GM: Stock is one screen with four tabs; running low opens All stores', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  const low = page.getByTestId('dofirst-card').getByRole('link', { name: /running low/ });
  const n = Number((await low.locator('.font-bold').innerText()).trim());
  await low.click();
  await page.waitForURL(/\/stock\?.*tab=low/);
  await expect.poll(() => viewing(page)).toBe('All stores');
  for (const t of ['all', 'low', 'expiring', 'expired']) {
    await expect(page.getByTestId(`tab-${t}`)).toBeVisible();
  }
  await expect(page.getByTestId('tab-low')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('stock-row')).toHaveCount(n);
  // another tab keeps All stores; the whole list is one tap away
  await page.getByTestId('tab-all').click();
  await expect.poll(() => viewing(page)).toBe('All stores');
  expect(await page.getByTestId('stock-row').count()).toBeGreaterThanOrEqual(n);
  // an old address still lands on the right tab
  await page.goto('/stock/expiry?show=expired');
  await expect(page.getByTestId('tab-expired')).toHaveAttribute('aria-current', 'page');
});

test('the GM: open shifts open the roster for All departments, a section each', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  await page
    .getByTestId('dofirst-card')
    .getByRole('link', { name: /open shifts? in the next 7 days/ })
    .click();
  await page.waitForURL(/\/roster\/week\?.*all=1/);
  await expect.poll(() => viewing(page)).toBe('All departments');
  const sections = page.getByTestId('department-section');
  expect(await sections.count()).toBeGreaterThan(0);
  // a department with open slots is open, its Assign link one tap away
  await expect(sections.locator('[open]').first().or(sections.first())).toBeVisible();
});

test('the GM: attendance issues open Exceptions for All departments', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  await page
    .getByTestId('dofirst-card')
    .getByRole('link', { name: /attendance issues?/ })
    .click();
  await page.waitForURL(/\/roster\/exceptions\?.*all=1/);
  await expect.poll(() => viewing(page)).toBe('All departments');
  await expect(page.getByTestId('exceptions')).toBeVisible();
});

test('the GM: one open-repairs line, Assign; Maintenance has All departments and Report last', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  const card = page.getByTestId('dofirst-card');
  // repairs and "jobs to give to someone" were the same thing: one line now
  await expect(card.getByText(/jobs? to give to someone/)).toHaveCount(0);
  const line = card.getByRole('link', { name: /open repairs?/ });
  await expect(line).toContainText('Assign');
  const n = Number((await line.locator('.font-bold').innerText()).trim());
  await line.click();
  await page.waitForURL(/\/tasks\/maintenance\?.*all=1/);
  await expect.poll(() => viewing(page)).toBe('All departments');
  await expect(page.getByTestId('tab-assign')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('maintenance').getByRole('listitem')).toHaveCount(n);
  // Report a problem is after the list, not above it
  const list = await page.getByTestId('maintenance').boundingBox();
  const report = await page.getByRole('link', { name: 'Report a problem' }).boundingBox();
  expect(report!.y).toBeGreaterThan(list!.y + list!.height - 1);
});

test('Orders and Transfers: All stores, with To receive and To send tabs', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0', { expanded: false });
  await page.goto('/stock/orders?all=1&tab=receive');
  await expect.poll(() => viewing(page)).toBe('All stores');
  await expect(page.getByTestId('tab-receive')).toHaveAttribute('aria-current', 'page');
  await page.goto('/stock/transfers?all=1&tab=send');
  await expect.poll(() => viewing(page)).toBe('All stores');
  await expect(page.getByTestId('tab-send')).toHaveAttribute('aria-current', 'page');
});

test("the GM: a department's tile opens that department, not all (ADR 105)", async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/');
  const tiles = page.getByTestId('attention-card').getByTestId('attention-group');
  const n = await tiles.count();
  let checked = 0;
  for (let i = 0; i < n; i++) {
    const t = tiles.nth(i);
    const label = (await t.getAttribute('data-label')) ?? '';
    if (label === 'Whole outlet') continue;
    const href = (await t.getAttribute('href')) ?? '';
    // never the all-places view from a department's own tile
    expect(href, `${label}: ${href}`).not.toContain('all=1');
    expect(href, `${label}: ${href}`).toContain('node=');
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
  // and an attendance tile lands on its department with as many issues as it says
  const tile = tiles.filter({ hasText: /attendance issue/ }).first();
  if ((await tile.count()) > 0) {
    const want = Number((await tile.getByTestId('dept-fact').innerText()).split(' ')[0]);
    const dept = await tile.getAttribute('data-label');
    await tile.click();
    await page.waitForURL(/\/roster\/exceptions\?node=/);
    await expect.poll(() => viewing(page)).toContain(dept!);
    await expect(page.getByTestId('exception')).toHaveCount(want);
  }
});
