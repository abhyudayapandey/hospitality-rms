import { expect, test, type Page } from '@playwright/test';
import { addDays, formatDay, localToday, weekStart } from '../lib/dates';
import {
  asMigrator,
  lateTemplate,
  PLACE,
  placeId,
  runExecutor,
  setupPeopleWeek,
  signInAs,
} from './helpers';

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

async function openWeek(page: Page, day = W) {
  await page.goto(`/roster/week?node=${await placeId(PLACE.floor)}&week=${W}&day=${day}`);
  await expect(page.getByTestId('week-label')).toHaveText(`Week of ${formatDay(W)}`);
}

/** The day's 17:00 evening shift for a role, in the day view's 17:00 time group (ADR 025). */
function evening(page: Page, day: string, role: string) {
  return page
    .getByRole('region', { name: formatDay(day) })
    .getByRole('region', { name: /^17:00–/ })
    .getByTestId('roster-shift')
    .filter({ hasText: `· ${role} ·` });
}

/** Assigns `worker` to the day's evening `role` shift (setupPeopleWeek made the drafts). */
async function assign(page: Page, day: string, role: string, worker: string) {
  await openWeek(page, day);
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

test('template shifts: tomorrow to day 7 only, confirm or cancel, then discard (ADR 024)', async ({
  page,
}) => {
  const today = localToday('Asia/Kolkata');
  const tomorrow = addDays(today, 1);
  await lateTemplate(true);
  await signInAs(page, 'Test Bar Manager 3.0');
  await page.goto(`/roster/week?node=${await placeId(PLACE.floor)}&week=${weekStart(tomorrow)}`);
  const window = page.getByTestId('template-window');
  await expect(window).toContainText(`${formatDay(tomorrow)} – ${formatDay(addDays(today, 7))}`);
  const addButton = page.getByRole('button', { name: 'Add template shifts' });
  const discardButton = page.getByRole('button', { name: /^Discard drafts/ });
  // the test data has next week's drafts: clear them first
  if (await discardButton.isVisible()) {
    await discardButton.click();
    await page
      .getByRole('group', { name: 'Discard drafts' })
      .getByRole('button', { name: 'Discard' })
      .click();
    await expect(page.getByRole('status')).toContainText('Discarded');
  }
  await expect(addButton).toBeVisible();

  // Cancel changes nothing
  await addButton.click();
  const confirm = page.getByRole('group', { name: 'Add template shifts' });
  await expect(confirm.getByTestId('confirm-text')).toContainText(/^Add \d+ draft shifts?, /);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(addButton).toBeVisible();

  // Add: the drafts start tomorrow, and Discard drafts takes Add's place
  await addButton.click();
  await confirm.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/^Added \d+ draft shifts?, /);
  await expect(discardButton).toBeVisible();
  await expect(addButton).toBeHidden();
  await expect(page.getByRole('region', { name: formatDay(today) }).getByText('draft')).toHaveCount(
    0,
  );

  // they stay after leaving the screen, until discarded
  await page.goto('/');
  await page.goBack();
  await expect(discardButton).toBeVisible();
  await discardButton.click();
  await page
    .getByRole('group', { name: 'Discard drafts' })
    .getByRole('button', { name: 'Keep drafts' })
    .click();
  await expect(discardButton).toBeVisible();
  await discardButton.click();
  await page
    .getByRole('group', { name: 'Discard drafts' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await expect(page.getByRole('status')).toContainText(/^Discarded \d+ draft shifts?\.$/);
  await expect(addButton).toBeVisible();
  await lateTemplate(false);
});

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
  await openWeek(page, FRIDAY);
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
    .getByTestId('shift-day')
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

test('swap past a rest warning: offered and accepted, the approver gives it to someone else', async ({
  page,
}) => {
  // ADR 019. A third server for the approver to pick, and a morning shift for the
  // colleague that leaves 5 h rest before Wednesday's 17:00 shift
  const WED = addDays(W, 2);
  const floor = await placeId(PLACE.floor);
  await asMigrator(
    `with t as (select id from core.tenant where code = 'TEST-COMPANY'),
     u as (insert into core.app_user (tenant_id, kind, display_name, username)
           select id, 'human', 'E2E Server B 3.0', 'e2e.server-b.3.0' from t
           on conflict (tenant_id, username) where username is not null
           do update set status = 'active' returning id, tenant_id),
     w as (insert into hr.worker (tenant_id, owner_user_id, org_node_id, role_code)
           select tenant_id, id, $1, 'SERVER' from u
           on conflict (tenant_id, owner_user_id) do nothing returning 1)
     insert into core.role_assignment (tenant_id, user_id, group_id, node_id)
     select u.tenant_id, u.id, g.id, $1 from u
       join core.security_group g on g.tenant_id = u.tenant_id and g.code = 'STAFF'
      where not exists (select 1 from core.role_assignment ra
                         where ra.user_id = u.id and ra.group_id = g.id)`,
    [floor],
  );
  await asMigrator(
    `with w as (select w.* from hr.worker w join core.app_user u on u.id = w.owner_user_id
                 where u.username = 'e2e.server.3.0'),
          s as (insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at,
                                      role_code, status, published_at)
                select w.tenant_id, $1, $2::date, ($2::date + time '06:00') at time zone 'Asia/Kolkata',
                       ($2::date + time '12:00') at time zone 'Asia/Kolkata', 'SERVER',
                       'published', now()
                  from w returning *)
     insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id,
                                      org_node_id, start_at, end_at)
     select s.tenant_id, s.id, w.id, w.owner_user_id, s.org_node_id, s.start_at, s.end_at
       from s, w`,
    [floor, WED],
  );

  await signInAs(page, 'Test Bar Manager 3.0');
  await assign(page, WED, 'server', 'Test Server 3.0');
  const publish = page.getByRole('button', { name: /^Publish/ });
  if (await publish.isEnabled()) await publish.click();

  // the offer and the acceptance go through: the rest rule is the approver's to weigh
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/roster/my');
  await page
    .getByTestId('my-shifts')
    .getByTestId('shift-day')
    .filter({ hasText: formatDay(WED) })
    .getByRole('link', { name: 'Swap' })
    .click();
  await page.getByLabel('E2E Server 3.0', { exact: true }).check();
  await page.getByRole('button', { name: 'Send offer' }).click();
  await page.waitForURL('**/roster/swaps');

  await signInAs(page, 'E2E Server 3.0');
  await page.goto('/roster/swaps');
  const offer = page
    .getByTestId('swaps')
    .locator('li')
    .filter({ hasText: 'Test Server 3.0 offers you' })
    .filter({ hasText: formatDay(WED) })
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
  await expect(page.getByTestId('swap-warnings')).toContainText(
    'E2E Server 3.0 would have 5 h rest between shifts (needs 10 h).',
  );
  await expect(page.getByRole('button', { name: 'Approve anyway' })).toBeVisible();
  const other = page.getByTestId('reassign-candidate').filter({ hasText: 'E2E Server B 3.0' });
  await other.getByRole('button', { name: 'Assign' }).click();
  await expect(other.getByRole('button', { name: 'Assigned' })).toBeVisible();

  await openWeek(page, WED);
  const shift = evening(page, WED, 'server');
  await expect(shift).toContainText('E2E Server B 3.0');
  await expect(shift).not.toContainText('Test Server 3.0');

  await signInAs(page, 'Test Server 3.0');
  await page.goto('/roster/swaps');
  await expect(
    page
      .getByTestId('swaps')
      .locator('li')
      .filter({ hasText: formatDay(WED) })
      .first(),
  ).toContainText('Your manager gave the shift to someone else');
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

test('exceptions: a department’s queue says whom each waits for; the GM picks the department', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0');
  // departments only on the switcher (ADR 016): the hotel itself falls back to one of them
  await page.goto(`/roster/exceptions?node=${await placeId('TEST-HOTEL-1.0')}`);
  await expect(
    page.getByRole('combobox', { name: 'Place' }).locator('option', { hasText: /Store$/ }),
  ).toHaveCount(0);
  await page.goto(`/roster/exceptions?node=${await placeId('TEST-HOTEL-1.0-HOUSEKEEPING')}`);
  const housekeeping = page
    .getByTestId('exceptions')
    .getByRole('region', { name: 'Test Hotel & Bar 1.0 – Housekeeping' });
  await expect(housekeeping).toBeVisible();
  // a housekeeping worker's exception waits for the executive housekeeper
  await expect(
    housekeeping
      .getByTestId('assignee')
      .filter({ hasText: 'Waiting for Test Executive Housekeeper 1.0' })
      .first(),
  ).toBeVisible();
});

test('events: the manager plans one with staff needed; staff read it on My shifts', async ({
  page,
}) => {
  const name = `E2E tasting ${Date.now()}`;
  await signInAs(page, 'Test Bar Manager 3.0');
  await page.goto(`/events?node=${await placeId(PLACE.floor)}`);
  await page.getByRole('link', { name: 'New event' }).click();
  const form = page.getByRole('form', { name: 'Event' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Date').fill(addDays(localToday('Asia/Kolkata'), 2));
  await form.getByLabel('Covers').fill('35');
  await form.getByRole('button', { name: 'Add staff' }).click();
  await form.getByLabel('Role').selectOption({ label: 'Server' });
  await form.getByLabel('Headcount').fill('3');
  await form.getByRole('button', { name: 'Create event' }).click();
  await page.waitForURL(/\/events\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('event-requirements')).toContainText('3 × Server');

  // Events is on the Team side, which staff don't have: they see the week's events on My
  // shifts, and open one read-only (ADR 025)
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/roster/my');
  await expect(page.getByRole('navigation', { name: 'Me', exact: true })).not.toContainText(
    'Events',
  );
  const week = page.getByTestId('events-this-week');
  await week.getByRole('link', { name: new RegExp(name) }).click();
  await page.waitForURL(/\/events\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('event-requirements')).toContainText('3 × Server');
  await page.goto('/events');
  await expect(page.getByTestId('events')).toContainText(name);
  await expect(page.getByRole('link', { name: 'New event' })).toHaveCount(0);
});

test('Roster is Me and Team: staff see only Me; the manager switches; HR has Team (ADR 025)', async ({
  page,
}) => {
  const sides = (p: Page) => p.getByRole('navigation', { name: 'Me or team' });
  const tabs = async (p: Page, side: 'Me' | 'Team') =>
    p.getByRole('navigation', { name: side, exact: true }).getByRole('link').allInnerTexts();

  // a server: Roster opens on My shifts; no switch, no team tabs
  await signInAs(page, 'Test Server 3.0');
  await page.goto('/roster');
  await page.waitForURL('**/roster/my');
  await expect(sides(page)).toHaveCount(0);
  expect(await tabs(page, 'Me')).toEqual(['My shifts', 'Clock', 'Leave', 'Swaps']);

  // the bar manager: Roster opens on Team; the switch goes to Me and back
  await signInAs(page, 'Test Bar Manager 3.0');
  await page.goto('/roster');
  await page.waitForURL(/\/roster\/week/);
  expect(await tabs(page, 'Team')).toEqual(['Roster', 'Exceptions', 'Events']);
  await expect(sides(page).getByRole('link', { name: 'Team' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await sides(page).getByRole('link', { name: 'Me' }).click();
  await page.waitForURL('**/roster/my');
  expect(await tabs(page, 'Me')).toEqual(['My shifts', 'Clock', 'Leave', 'Swaps']);
  await sides(page).getByRole('link', { name: 'Team' }).click();
  await page.waitForURL(/\/roster\/week/);

  // HR at head office has no shifts of their own: Team, and their own Leave on Me
  await signInAs(page, 'Test HR Admin');
  await page.goto('/roster');
  await page.waitForURL(/\/roster\/week/);
  await sides(page).getByRole('link', { name: 'Me' }).click();
  await page.waitForURL('**/leave');
  await expect(page.getByRole('navigation', { name: 'Me', exact: true })).toHaveCount(0);
});

test('day strip: open slots per day match the list view; a day shows its time groups (ADR 025)', async ({
  page,
}) => {
  await signInAs(page, 'Test Bar Manager 3.0');
  await openWeek(page, FRIDAY);
  const chips = page.getByRole('navigation', { name: 'Days' }).getByTestId('day-chip');
  await expect(chips).toHaveCount(7);
  await expect(chips.nth(4)).toHaveAttribute('aria-current', 'date');
  const day = page.getByTestId('roster-day');
  await expect(day).toHaveAttribute('aria-label', formatDay(FRIDAY));
  await expect(day.getByTestId('time-group').first()).toBeVisible();

  // Friday's shifts in the day view equal Friday's cards in the list view
  const dayCount = await day.getByTestId('roster-shift').count();
  const open = Number(await chips.nth(4).getAttribute('data-open'));
  await page.getByRole('link', { name: 'List view' }).click();
  await page.waitForURL(/view=list/);
  const friday = page.getByRole('region', { name: formatDay(FRIDAY) });
  await expect(friday.getByTestId('roster-shift')).toHaveCount(dayCount);
  const slots = await friday.getByTestId('roster-shift').allInnerTexts();
  const openInList = slots
    .map((t) => /(\d+)\/(\d+)/.exec(t)!)
    .reduce((n, m) => n + Math.max(0, Number(m[2]) - Number(m[1])), 0);
  expect(openInList).toBe(open);

  // the week arrows keep List view; Day view goes back to the strip
  await page.getByRole('link', { name: 'Next week' }).click();
  await page.waitForURL(/view=list/);
  await page.getByRole('link', { name: 'Day view' }).click();
  await expect(page.getByRole('navigation', { name: 'Days' })).toBeVisible();
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

test('the sole owner: own leave approved at the top of the chain; the admin page says why', async ({
  page,
}) => {
  // a day far enough out (and different each run) not to overlap an earlier run's leave
  const day = new Date(Date.now() + (400 + (Math.floor(Date.now() / 1000) % 900)) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await signInAs(page, 'Test Bar Manager');
  await page.goto('/leave');
  const form = page.getByRole('form', { name: 'Request leave' });
  await form.getByLabel('Type').selectOption({ label: 'Unpaid Leave' });
  await form.getByLabel('From', { exact: true }).fill(day);
  await form.getByLabel('To', { exact: true }).fill(day);
  await form.getByRole('button', { name: 'Request 1 day' }).click();
  await expect(form.getByRole('status')).toContainText('Leave requested');

  await page.goto('/requests');
  const mine = page.getByTestId('request-item').filter({ hasText: 'Leave' }).first();
  await expect(mine.getByTestId('request-state')).toHaveText('approved');
  await expect(mine.getByTestId('top-of-chain')).toHaveText(
    'Approved automatically: top of chain, no higher approver.',
  );

  await page.goto('/admin');
  await expect(page.getByTestId('sole-owner')).toContainText(
    'Adding a second account owner turns approvals on.',
  );
  await expect(page.getByTestId('access-audit')).toContainText('top of chain: no higher approver');
});
