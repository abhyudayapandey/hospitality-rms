import { expect, test } from '@playwright/test';
import { addDays, localToday, weekStart } from '../lib/dates';
import { asMigrator, placeId, signInAs } from './helpers';

// Me per person, roster and clock, pictures on people's lists (ADR 106 to 108), at 380 px.

test.use({ viewport: { width: 380, height: 900 } });

test("Me: a server's own day first, the rest under More; no two tiles share a picture", async ({
  page,
}) => {
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/me');
  const tiles = page.getByTestId('me-tiles');
  await expect(tiles.getByTestId('me-clock')).toBeVisible();
  await expect(tiles.getByTestId('me-leave')).toBeVisible();
  // what every shift worker may open is folded
  await expect(page.getByTestId('me-logbook')).toHaveCount(0);
  await page.getByTestId('me-more').click();
  await expect(page.getByTestId('me-logbook')).toBeVisible();
  await expect(page.getByTestId('me-registers')).toBeVisible();
  const icons = await tiles.locator('a svg[data-icon]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-icon')),
  );
  expect(icons.length).toBeGreaterThan(8);
  expect(new Set(icons).size).toBe(icons.length);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(380);
});

test('Me: a commis has Make, Recipes and Opened packs first', async ({ page }) => {
  await signInAs(page, 'Test Commis 1.0');
  await page.goto('/me');
  const tiles = page.getByTestId('me-tiles');
  for (const k of ['clock', 'make', 'menu', 'opened']) {
    await expect(tiles.getByTestId(`me-${k}`), k).toBeVisible();
  }
  await expect(tiles.getByTestId('me-menu').locator('svg')).toHaveAttribute('data-icon', 'chefHat');
});

test('an empty roster week: one Fill button adds the usual shifts as drafts', async ({ page }) => {
  const eng = await placeId('TEST-HOTEL-1.1-ENGINEERING');
  const today = localToday('Asia/Kolkata');
  // the week of day 7 is always inside "tomorrow to day 7"
  const monday = weekStart(addDays(today, 7));
  await asMigrator(
    `with s as (select id from hr.shift where org_node_id = $1
                   and local_date between $2::date and $2::date + 6)
     , a as (delete from hr.shift_assignment where shift_id in (select id from s))
     delete from hr.shift where id in (select id from s)`,
    [eng, monday],
  );
  await signInAs(page, 'Test Chief Engineer 1.1');
  await page.goto(`/roster/week?node=${eng}&week=${monday}&view=shift`);
  await expect(page.getByTestId('week-summary')).toHaveCount(0);
  await expect(page.getByTestId('view-shift')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('fill-week').click();
  await expect(page.getByTestId('week-summary')).toContainText('draft');
  await expect(page.getByTestId('roster-shift').first().locator('svg').first()).toHaveAttribute(
    'data-icon',
    /^(sun|moon|split)$/,
  );
  // the switch: By person
  await page.getByTestId('view-people').click();
  await page.waitForURL(/view=people/);
  await expect(page.getByTestId('view-people')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('person-row').first().getByTestId('initials')).toBeVisible();
});

test('the clock: one big camera button; no shift today says so', async ({ page }) => {
  const shifts = await asMigrator<{ n: number }>(
    `select count(*)::int as n from hr.shift_assignment a join hr.shift s on s.id = a.shift_id
       join core.app_user u on u.id = a.owner_user_id
      where u.display_name = 'Test Banquet Server 1.0' and a.status = 'assigned'
        and s.status = 'published' and s.local_date = $1::date`,
    [localToday('Asia/Kolkata')],
  );
  await signInAs(page, 'Test Banquet Server 1.0');
  await page.goto('/roster/clock');
  const button = page.getByRole('button', { name: /^Clock (in with a selfie|out)$/ });
  await expect(button).toBeVisible();
  if ((await button.textContent())?.includes('Clock in')) {
    await expect(button.locator('svg')).toHaveAttribute('data-icon', 'camera');
    if (shifts[0]!.n === 0) {
      await expect(page.getByTestId('clock-state')).toHaveText('No shift today');
    }
  }
});

test('pictures: leave types, notifications, people rows', async ({ page }) => {
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/leave');
  const balance = page.getByTestId('balances').locator('li').first();
  await expect(balance.locator('svg')).toHaveAttribute('data-icon', /.+/);
  await page.goto('/notifications');
  const first = page.getByTestId('notifications').locator('li').first();
  if (await first.isVisible()) {
    await expect(first.locator('svg').first()).toHaveAttribute('data-icon', /.+/);
  }
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/team/people');
  await expect(page.getByTestId('person').first().getByTestId('initials')).toBeVisible();
});
