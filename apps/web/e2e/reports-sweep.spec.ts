import { expect, test, type Page } from '@playwright/test';
import { settled, signInAs } from './helpers';

// Every report, for one person of every kind of report access (the 14 shapes the test
// customers have), opens without an error, and no figure reads NaN, undefined, null or
// "Invalid Date". Each report's own links (trends, breakdowns, a dish, an item, another
// place) are opened too, a few each. The numbers themselves are pinned by the DB tests
// (reports-reconcile.db.test.ts and the report tests); this is the screens.

const PEOPLE = [
  'Test Account Owner',
  'Test Area Manager',
  'Test General Manager 1.0',
  'Test Bar Manager 3.0',
  'Test Executive Chef 1.0',
  'Test Bar Manager 1.0',
  'Test Central Kitchen Manager',
  'Test Central Kitchen Store Keeper',
  'Test Central Kitchen Supervisor',
  'Test Cost Controller 1.0',
  'Test Executive Housekeeper 1.0',
  'Test HR Admin',
  'Test Head Bartender',
  'Test Store Keeper 1.0',
  'Test Banquet Captain 1.0',
  'Test Server 3.0',
];

const BAD =
  /\bNaN\b|\bundefined\b|\bnull\b|Invalid Date|Something went wrong|Application error|This page could not be found|Internal Server Error/;

async function clean(page: Page, where: string) {
  await settled(page);
  const text = await page.locator('main').innerText();
  expect(text, where).not.toMatch(BAD);
}

for (const who of PEOPLE) {
  test(`reports open cleanly for ${who}`, async ({ page }) => {
    test.setTimeout(240_000);
    await signInAs(page, who, { expanded: false });
    const res = await page.goto('/reports');
    expect(res?.status(), 'reports list').toBeLessThan(400);
    await clean(page, `${who} /reports`);
    const reports = await page
      .getByTestId('report-list')
      .getByRole('link')
      .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))
      .catch(() => [] as string[]);
    for (const href of reports) {
      const r = await page.goto(href);
      expect(r?.status(), `${who} ${href}`).toBeLessThan(400);
      await clean(page, `${who} ${href}`);
      // the report's own links, a few each: a trend, a breakdown, a dish, an item, a place
      const inner = await page
        .locator('main a[href^="/reports"]')
        .evaluateAll((as) =>
          [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))].filter(
            (h) => !h.startsWith('/reports/csv'),
          ),
        );
      for (const link of inner.slice(0, 6)) {
        const r2 = await page.goto(link);
        expect(r2?.status(), `${who} ${link}`).toBeLessThan(400);
        await clean(page, `${who} ${link}`);
      }
    }
  });
}

test('Today so far: each figure opens its trend, and On shift today is the people on shift', async ({
  page,
}) => {
  await signInAs(page, 'Test Executive Chef 1.0', { expanded: false });
  const card = page.getByTestId('numbers-card');
  const onShift = Number(
    (await card.getByTestId('tile-shifts').locator('span').nth(1).innerText()).trim(),
  );
  // the people on the department's screen are the same count (ADR 057)
  await card.getByRole('link', { name: 'Open the report' }).click();
  await page.waitForURL(/\/reports\/department/);
  await settled(page);
  await expect(page.getByTestId('on-shift')).toHaveCount(onShift);
  await page.goBack();
  await page.getByTestId('numbers-card').getByTestId('tile-shifts').click();
  await page.waitForURL(/\/reports\/trend\?report=department&.*measure=shifts/);
  await clean(page, 'shifts trend');
  await page.goBack();
  await page.getByTestId('numbers-card').getByTestId('tile-not_in').click();
  await page.waitForURL(/\/reports\/department\?node=/);
});
