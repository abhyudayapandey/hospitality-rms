import { expect, test, type Page } from '@playwright/test';
import { addDays, formatDay, localToday, weekStart } from '../lib/dates';
import { ORG, resetPeopleWeek, runExecutor, signInAs } from './helpers';

// Rostering, leave, swaps, clock-in and events through the real screens on the production
// build (ADR 008). The flows use a week four weeks out at Outlet A, cleared first, so the
// spec can re-run on a local database.

const W = weekStart(addDays(localToday('Asia/Kolkata'), 28));
const MONDAY = W;
const FRIDAY = addDays(W, 4);

test.beforeAll(async () => {
  await resetPeopleWeek(W);
});

async function openWeek(page: Page) {
  await page.goto(`/roster/week?node=${ORG.outletA}&week=${W}`);
  await expect(page.getByTestId('week-label')).toHaveText(`Week of ${formatDay(W)}`);
}

/** Builds the week (idempotent) and assigns `worker` to the day's shift starting `time`. */
async function assign(page: Page, day: string, time: string, worker: string) {
  await openWeek(page);
  const build = page.getByRole('button', { name: /^(Build week|Add template shifts)$/ });
  await build.click();
  await expect(page.getByRole('status')).toBeVisible();
  const shift = page
    .getByRole('region', { name: formatDay(day) })
    .getByTestId('roster-shift')
    .filter({ hasText: `${time}–` });
  await shift.getByRole('link', { name: /^Assign/ }).click();
  await page
    .getByTestId('candidates')
    .locator('li')
    .filter({ hasText: worker })
    .getByRole('button', { name: 'Assign' })
    .click();
  await page.waitForURL(/\/roster\/week/);
  await expect(
    page
      .getByRole('region', { name: formatDay(day) })
      .getByTestId('roster-shift')
      .filter({ hasText: `${time}–` }),
  ).toContainText(worker);
}

test('manager builds and publishes; approved leave drops the shift after both approvals', async ({
  page,
}) => {
  await signInAs(page, 'Olivia Outlet Manager');
  await assign(page, FRIDAY, '15:00', 'Priya Server');
  await page.getByRole('button', { name: /^Publish/ }).click();
  await expect(page.getByRole('status')).toContainText('Staff have been notified');

  // Priya sees the roster notification and asks for unpaid leave that day
  await signInAs(page, 'Priya Server');
  await expect(page.getByTestId('unread-count')).toBeVisible();
  await page.goto('/leave');
  const form = page.getByRole('form', { name: 'Request leave' });
  await form.getByLabel('Type').selectOption({ label: 'Unpaid leave' });
  await form.getByLabel('From').fill(FRIDAY);
  await form.getByLabel('To').fill(FRIDAY);
  await expect(form.getByTestId('leave-days')).toHaveText('1 calendar day');
  await form.getByRole('button', { name: 'Request 1 day' }).click();
  await expect(form.getByRole('status')).toContainText('Leave requested');
  await expect(page.getByTestId('my-leave').locator('li').first()).toContainText(
    'Waiting for approval',
  );

  // The outlet manager reviews: the screen lists the shift approval will drop
  await signInAs(page, 'Olivia Outlet Manager');
  await page.goto('/inbox');
  await page
    .getByTestId('inbox-item')
    .filter({ hasText: 'Priya Server' })
    .filter({ hasText: 'Leave' })
    .getByRole('link', { name: 'Review' })
    .first()
    .click();
  await expect(page.getByTestId('leave-drops')).toContainText('Approving removes this shift');
  await expect(page.getByTestId('leave-drops')).toContainText('15:00–23:00');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toHaveText('Approved');

  // then HR
  await signInAs(page, 'Harper HR Admin');
  await page.goto('/inbox');
  await page
    .getByTestId('inbox-item')
    .filter({ hasText: 'Priya Server' })
    .filter({ hasText: 'Leave' })
    .getByRole('link', { name: 'Review' })
    .first()
    .click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toHaveText('Approved');
  await runExecutor(); // hr.leave.apply

  await signInAs(page, 'Priya Server');
  await page.goto('/leave');
  await expect(page.getByTestId('my-leave').locator('li').first()).toContainText('Approved');
  await page.goto('/notifications');
  await expect(page.getByTestId('notifications')).toContainText('Leave approved');

  await signInAs(page, 'Olivia Outlet Manager');
  await openWeek(page);
  const dinner = page
    .getByRole('region', { name: formatDay(FRIDAY) })
    .getByTestId('roster-shift')
    .filter({ hasText: '15:00–' });
  await expect(dinner).not.toContainText('Priya Server');
  await expect(dinner).toContainText('0/2');
});

test('shift swap: offered, accepted by the colleague, approved by the manager', async ({
  page,
}) => {
  await signInAs(page, 'Olivia Outlet Manager');
  await assign(page, MONDAY, '07:00', 'Sam Staff');
  const publish = page.getByRole('button', { name: /^Publish/ });
  if (await publish.isEnabled()) await publish.click();

  await signInAs(page, 'Sam Staff');
  await page.goto('/roster/my');
  await page
    .getByTestId('my-shifts')
    .locator('li')
    .filter({ hasText: formatDay(MONDAY) })
    .getByRole('link', { name: 'Swap' })
    .click();
  await page.getByLabel('Priya Server').check();
  await page.getByRole('button', { name: 'Send offer' }).click();
  await page.waitForURL('**/roster/swaps');
  await expect(page.getByTestId('swaps').locator('li').first()).toContainText(
    'Waiting for your colleague',
  );

  await signInAs(page, 'Priya Server');
  await page.goto('/roster/swaps');
  const offer = page
    .getByTestId('swaps')
    .locator('li')
    .filter({ hasText: 'Sam Staff offers you' })
    .first();
  await offer.getByRole('button', { name: 'Accept' }).click();
  await expect(offer).toContainText('Waiting for manager approval');

  await signInAs(page, 'Olivia Outlet Manager');
  await page.goto('/inbox');
  await page
    .getByTestId('inbox-item')
    .filter({ hasText: 'Shift Swap' })
    .filter({ hasText: 'Priya Server' })
    .getByRole('link', { name: 'Review' })
    .first()
    .click();
  await expect(page.getByTestId('swap-parties')).toHaveText('Sam Staff → Priya Server');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toHaveText('Approved');
  await runExecutor(); // hr.shift_swap.apply

  await openWeek(page);
  const breakfast = page
    .getByRole('region', { name: formatDay(MONDAY) })
    .getByTestId('roster-shift')
    .filter({ hasText: '07:00–' });
  await expect(breakfast).toContainText('Priya Server');
  await expect(breakfast).not.toContainText('Sam Staff');
});

test('clock in outside the fence is recorded and flagged for the manager', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await signInAs(page, 'Sam Staff');
  await page.goto('/roster/clock');
  // a previous run may have left Sam clocked in
  if (await page.getByRole('button', { name: 'Clock out' }).isVisible()) {
    await context.setGeolocation({ latitude: 12.9716, longitude: 77.5946 });
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(page.getByRole('button', { name: 'Clock in' })).toBeVisible();
  }
  await context.setGeolocation({ latitude: 12.99, longitude: 77.5946 }); // ~2 km away
  await page.getByRole('button', { name: 'Clock in' }).click();
  await expect(page.getByRole('status')).toContainText('m from the outlet');
  await expect(page.getByTestId('clock-state')).toContainText('Clocked in since');

  await context.setGeolocation({ latitude: 12.9716, longitude: 77.5946 });
  await page.getByRole('button', { name: 'Clock out' }).click();
  await expect(page.getByRole('status')).toContainText('Clocked out at');

  await signInAs(page, 'Olivia Outlet Manager');
  await page.goto(`/roster/exceptions?node=${ORG.outletA}`);
  const rows = page
    .getByTestId('exceptions')
    .locator('li')
    .filter({ hasText: 'Sam Staff' })
    .filter({ hasText: 'Outside the outlet' });
  await expect(rows.first()).toBeVisible();
  const open = await rows.count();
  await rows.first().getByRole('button', { name: 'Resolve' }).click();
  await expect(rows).toHaveCount(open - 1);
});

test('events: the manager plans one with staff needed; staff can read it', async ({ page }) => {
  const name = `E2E tasting ${Date.now()}`;
  await signInAs(page, 'Olivia Outlet Manager');
  await page.goto(`/events?node=${ORG.outletA}`);
  await page.getByRole('link', { name: 'New event' }).click();
  const form = page.getByRole('form', { name: 'Event' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Covers').fill('35');
  await form.getByRole('button', { name: 'Add staff' }).click();
  await form.getByLabel('Role').selectOption({ label: 'Server' });
  await form.getByLabel('Headcount').fill('3');
  await form.getByRole('button', { name: 'Create event' }).click();
  await page.waitForURL(/\/events\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('event-requirements')).toContainText('3 × server');

  await signInAs(page, 'Sam Staff');
  await page.goto('/events');
  await expect(page.getByTestId('events')).toContainText(name);
  await expect(page.getByRole('link', { name: 'New event' })).toHaveCount(0);
});
