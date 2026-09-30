import { expect, test, type Page } from '@playwright/test';
import { addDays, formatDay, localToday, weekStart } from '../lib/dates';
import { PLACE, placeId, runExecutor, setupPeopleWeek, signInAs } from './helpers';

// Rostering, leave, swaps, clock-in and events through the real screens on the production
// build (ADR 008), in Test Bar 3.0's Floor Service: the Bar Manager rosters the server and
// the host on the evening templates from file 16. The flows use a week four weeks out,
// cleared first, so the spec can re-run on a local database; a second server (a fixture)
// is the colleague for the swap, since the test data has one person per role there.

const W = weekStart(addDays(localToday('Asia/Kolkata'), 28));
const MONDAY = W;
const FRIDAY = addDays(W, 4);

// Test Bar 3.0's geofence (file 04), and a point about 3.8 km north of it
const AT_BAR = { latitude: 19.066, longitude: 72.8367 };
const AWAY = { latitude: 19.1, longitude: 72.8367 };

test.beforeAll(async () => {
  await setupPeopleWeek(W);
});

async function openWeek(page: Page) {
  await page.goto(`/roster/week?node=${await placeId(PLACE.floor)}&week=${W}`);
  await expect(page.getByTestId('week-label')).toHaveText(`Week of ${formatDay(W)}`);
}

/** The day's 17:00 evening shift for a role (lower-case role code, as the card shows it). */
function evening(page: Page, day: string, role: string) {
  return page
    .getByRole('region', { name: formatDay(day) })
    .getByTestId('roster-shift')
    .filter({ hasText: '17:00–' })
    .filter({ hasText: `· ${role} ·` });
}

/** Builds the week (idempotent) and assigns `worker` to the day's evening `role` shift. */
async function assign(page: Page, day: string, role: string, worker: string) {
  await openWeek(page);
  const build = page.getByRole('button', { name: /^(Build week|Add template shifts)$/ });
  await build.click();
  await expect(page.getByRole('status')).toBeVisible();
  await evening(page, day, role)
    .getByRole('link', { name: /^Assign/ })
    .click();
  await page
    .getByTestId('candidates')
    .locator('li')
    .filter({ hasText: worker })
    .getByRole('button', { name: 'Assign' })
    .click();
  await page.waitForURL(/\/roster\/week/);
  await expect(evening(page, day, role)).toContainText(worker);
}

test('manager builds and publishes; approved leave drops the shift after both approvals', async ({
  page,
}) => {
  await signInAs(page, 'Test Bar Manager 3.0');
  await assign(page, FRIDAY, 'host', 'Test Host 3.0');
  await page.getByRole('button', { name: /^Publish/ }).click();
  await expect(page.getByRole('status')).toContainText('Staff have been notified');

  // The host sees the roster notification and asks for unpaid leave that day
  await signInAs(page, 'Test Host 3.0');
  await expect(page.getByTestId('unread-count')).toBeVisible();
  await page.goto('/leave');
  const form = page.getByRole('form', { name: 'Request leave' });
  await form.getByLabel('Type').selectOption({ label: 'Unpaid Leave' });
  await form.getByLabel('From', { exact: true }).fill(FRIDAY);
  await form.getByLabel('To', { exact: true }).fill(FRIDAY);
  await expect(form.getByTestId('leave-days')).toHaveText('1 calendar day');
  await form.getByRole('button', { name: 'Request 1 day' }).click();
  await expect(form.getByRole('status')).toContainText('Leave requested');
  await expect(page.getByTestId('my-leave').locator('li').first()).toContainText(
    'Waiting for approval',
  );

  // The department head (Floor Manager) reviews: the screen lists the shift approval will drop
  await signInAs(page, 'Test Floor Manager 3.0');
  await page.goto('/inbox');
  await page
    .getByTestId('inbox-item')
    .filter({ hasText: 'Test Host 3.0' })
    .filter({ hasText: 'Leave' })
    .getByRole('link', { name: 'Review' })
    .first()
    .click();
  await expect(page.getByTestId('leave-drops')).toContainText('Approving removes this shift');
  await expect(page.getByTestId('leave-drops')).toContainText('17:00–01:00');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toHaveText('Approved');

  // then HR
  await signInAs(page, 'Test HR Admin');
  await page.goto('/inbox');
  await page
    .getByTestId('inbox-item')
    .filter({ hasText: 'Test Host 3.0' })
    .filter({ hasText: 'Leave' })
    .getByRole('link', { name: 'Review' })
    .first()
    .click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toHaveText('Approved');
  await runExecutor(); // hr.leave.apply

  await signInAs(page, 'Test Host 3.0');
  await page.goto('/leave');
  await expect(page.getByTestId('my-leave').locator('li').first()).toContainText('Approved');
  await page.goto('/notifications');
  await expect(page.getByTestId('notifications')).toContainText('Leave approved');

  await signInAs(page, 'Test Bar Manager 3.0');
  await openWeek(page);
  const shift = evening(page, FRIDAY, 'host');
  await expect(shift).not.toContainText('Test Host 3.0');
  await expect(shift).toContainText('0/1');
});

test('shift swap: offered, accepted by the colleague, approved by the manager', async ({
  page,
}) => {
  await signInAs(page, 'Test Bar Manager 3.0');
  await assign(page, MONDAY, 'server', 'Test Server 3.0');
  const publish = page.getByRole('button', { name: /^Publish/ });
  if (await publish.isEnabled()) await publish.click();

  await signInAs(page, 'Test Server 3.0');
  await page.goto('/roster/my');
  await page
    .getByTestId('my-shifts')
    .locator('li')
    .filter({ hasText: formatDay(MONDAY) })
    .getByRole('link', { name: 'Swap' })
    .click();
  await page.getByLabel('E2E Server 3.0').check();
  await page.getByRole('button', { name: 'Send offer' }).click();
  await page.waitForURL('**/roster/swaps');
  await expect(page.getByTestId('swaps').locator('li').first()).toContainText(
    'Waiting for your colleague',
  );

  await signInAs(page, 'E2E Server 3.0');
  await page.goto('/roster/swaps');
  const offer = page
    .getByTestId('swaps')
    .locator('li')
    .filter({ hasText: 'Test Server 3.0 offers you' })
    .first();
  await offer.getByRole('button', { name: 'Accept' }).click();
  await expect(offer).toContainText('Waiting for manager approval');

  await signInAs(page, 'Test Floor Manager 3.0');
  await page.goto('/inbox');
  await page
    .getByTestId('inbox-item')
    .filter({ hasText: 'Shift Swap' })
    .filter({ hasText: 'E2E Server 3.0' })
    .getByRole('link', { name: 'Review' })
    .first()
    .click();
  await expect(page.getByTestId('swap-parties')).toHaveText('Test Server 3.0 → E2E Server 3.0');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toHaveText('Approved');
  await runExecutor(); // hr.shift_swap.apply

  await openWeek(page);
  const shift = evening(page, MONDAY, 'server');
  await expect(shift).toContainText('E2E Server 3.0');
  await expect(shift).not.toContainText('Test Server 3.0');
});

test('clock in outside the fence is recorded and flagged for the manager', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/roster/clock');
  // a previous run may have left the server clocked in
  if (await page.getByRole('button', { name: 'Clock out' }).isVisible()) {
    await context.setGeolocation(AT_BAR);
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(page.getByRole('button', { name: 'Clock in' })).toBeVisible();
  }
  await context.setGeolocation(AWAY);
  await page.getByRole('button', { name: 'Clock in' }).click();
  await expect(page.getByRole('status')).toContainText('m from the outlet');
  await expect(page.getByTestId('clock-state')).toContainText('Clocked in since');

  await context.setGeolocation(AT_BAR);
  await page.getByRole('button', { name: 'Clock out' }).click();
  await expect(page.getByRole('status')).toContainText('Clocked out at');

  await signInAs(page, 'Test Bar Manager 3.0');
  await page.goto(`/roster/exceptions?node=${await placeId(PLACE.floor)}`);
  const rows = page
    .getByTestId('exceptions')
    .locator('li')
    .filter({ hasText: 'Test Server 3.0' })
    .filter({ hasText: 'Outside the outlet' });
  await expect(rows.first()).toBeVisible();
  const open = await rows.count();
  await rows.first().getByRole('button', { name: 'Resolve' }).click();
  await expect(rows).toHaveCount(open - 1);
});

test('events: the manager plans one with staff needed; staff can read it', async ({ page }) => {
  const name = `E2E tasting ${Date.now()}`;
  await signInAs(page, 'Test Bar Manager 3.0');
  await page.goto(`/events?node=${await placeId(PLACE.floor)}`);
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

  await signInAs(page, 'Test Server 3.0');
  await page.goto('/events');
  await expect(page.getByTestId('events')).toContainText(name);
  await expect(page.getByRole('link', { name: 'New event' })).toHaveCount(0);
});

test('offline clock-in is saved on the phone and synced with its time when back online', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(AT_BAR);
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/roster/clock');
  if (await page.getByRole('button', { name: 'Clock out' }).isVisible()) {
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(page.getByRole('button', { name: 'Clock in' })).toBeVisible();
  }
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Clock in' }).click();
  await expect(page.getByRole('status')).toContainText('saved on this phone');
  await expect(page.getByTestId('clock-waiting')).toHaveText('1 punch waiting to sync');
  await expect(page.getByRole('button', { name: 'Clock out' })).toBeVisible();

  await context.setOffline(false); // 'online' -> PunchSync replays with source offline
  await expect(page.getByTestId('clock-waiting')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('clock-state')).toContainText('Clocked in since');
  await page.getByRole('button', { name: 'Clock out' }).click();
  await expect(page.getByRole('status')).toContainText('Clocked out at');
});
