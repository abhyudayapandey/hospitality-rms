import { expect, test } from '@playwright/test';
import { asMigrator, signInAs } from './helpers';

// Prompt 11a (ADR 018): the profile, signing out of all devices, an outlet's location set
// in the app, and My shifts / Clock on the shared matching rule.

test('the header name opens your profile: details, access in words, and the password form', async ({
  page,
}) => {
  await signInAs(page, 'Test Commis 1.0');
  await page.getByTestId('current-user').click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByTestId('profile-username')).toHaveText('test.commis.1.0');
  await expect(page.getByTestId('profile-job role')).toHaveText('Commis');
  await expect(page.getByTestId('profile-home place')).toHaveText('Test Hotel & Bar 1.0 – Kitchen');
  await expect(page.getByTestId('profile-sign-in')).toHaveText('Username and password');
  const self = page.locator('[data-testid="access-grant"][data-group="SELF"]');
  await expect(self).toContainText('Yourself, wherever you work');
  await expect(self).toContainText('Change: attendance, leave, shift swaps');
  // a commis sets no locations
  await expect(page.getByRole('link', { name: /Outlet location/ })).toHaveCount(0);

  const form = page.getByTestId('password-form');
  await form.getByLabel('Current password').fill('whatever-it-was-1');
  await form.getByLabel('New password', { exact: true }).fill('short1');
  await expect(form).toContainText('Still needs: at least 10 characters');
  await form.getByLabel('New password', { exact: true }).fill('kitchen-2026');
  await form.getByLabel('New password again').fill('kitchen-2027');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(form.getByRole('alert')).toHaveText('The two new passwords are not the same.');
  await form.getByLabel('New password again').fill('kitchen-2026');
  await form.getByRole('button', { name: 'Change password' }).click();
  // no Cognito in e2e: the no-op directory accepts it; the database records it
  await expect(form.getByRole('status')).toContainText('Password changed');
});

test('sign out of all devices ends the other browser’s session too', async ({ page, browser }) => {
  const other = await browser.newPage();
  await signInAs(other, 'Test Room Attendant B 1.0');
  await signInAs(page, 'Test Room Attendant B 1.0');
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Sign out of all devices' }).click();
  await page.getByTestId('confirm-sign-out-everywhere').click();
  await page.waitForURL(/\/login\?reason=signed_out_everywhere/);
  await expect(page.getByText(/signed out on all your devices/)).toBeVisible();

  await other.goto('/inbox');
  await expect(other).toHaveURL(/\/login/);
  await other.close();
  // signing in again afterwards works
  await signInAs(page, 'Test Room Attendant B 1.0');
});

test.describe('outlet location', () => {
  test.use({
    geolocation: { latitude: 19.0596, longitude: 72.8295, accuracy: 18 },
    permissions: ['geolocation'],
  });

  test('the GM sets it from their phone’s location and checks the pin on a map', async ({
    page,
  }) => {
    await signInAs(page, 'Test General Manager 1.0');
    await page.goto('/profile');
    await page.getByRole('link', { name: /Outlet location/ }).click();
    const place = page.locator('[data-testid="location-place"][data-code="TEST-HOTEL-1.0"]');
    await expect(page.getByTestId('location-place')).toHaveCount(1);
    await place.getByRole('button', { name: 'Use my current location' }).click();
    await expect(place.getByTestId('location-accuracy')).toHaveText('Accurate to about ± 18 m.');
    await expect(place.getByLabel('Latitude')).toHaveValue('19.0596');
    await expect(place.getByTestId('map-link')).toHaveAttribute(
      'href',
      /openstreetmap\.org\/\?mlat=19\.0596&mlon=72\.8295/,
    );
    await place.getByLabel(/Clock-in radius/).fill('150');
    await place.getByRole('button', { name: 'Save location' }).click();
    await expect(place.getByRole('status')).toHaveText('Saved. The next clock-in uses it.');
    await expect(place.getByTestId('location-source')).toContainText(
      'Set in the app by Test General Manager 1.0',
    );
  });

  test('a department head cannot set it', async ({ page }) => {
    await signInAs(page, 'Test Executive Chef 1.0');
    await page.goto('/settings/location');
    await expect(page.getByText('You can’t set the location of any place.')).toBeVisible();
  });
});

test.describe('My shifts on the matching rule', () => {
  const NAME = 'Test Steward B 1.0';
  let shift = '';

  test.beforeAll(async () => {
    // yesterday 08:00–20:00 IST, worked 07:00–19:00 (the brief's example)
    const [s] = await asMigrator<{ id: string }>(
      `with w as (select w.* from hr.worker w join core.app_user u on u.id = w.owner_user_id
                   where u.display_name = $1),
            d as (select ((now() at time zone 'Asia/Kolkata')::date - 1) as day),
            s as (insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at,
                                        role_code, status, published_at)
                  select w.tenant_id, w.org_node_id, d.day,
                         (d.day + time '08:00') at time zone 'Asia/Kolkata',
                         (d.day + time '20:00') at time zone 'Asia/Kolkata',
                         w.role_code, 'published', now()
                    from w, d returning *),
            a as (insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id,
                                                   org_node_id, start_at, end_at)
                  select s.tenant_id, s.id, w.id, w.owner_user_id, s.org_node_id, s.start_at,
                         s.end_at from s, w returning shift_id)
       insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, clock_in_at,
                                  clock_out_at, in_source, out_source, in_key, out_key)
       select w.tenant_id, w.id, w.owner_user_id, w.org_node_id,
              (d.day + time '07:00') at time zone 'Asia/Kolkata',
              (d.day + time '19:00') at time zone 'Asia/Kolkata',
              'online', 'online', 'e2e-11a-in', 'e2e-11a-out'
         from w, d
       returning (select shift_id from a) as id`,
      [NAME],
    );
    shift = s!.id;
  });

  test.afterAll(async () => {
    await asMigrator(`delete from hr.attendance where in_key = 'e2e-11a-in'`, []);
    await asMigrator(`delete from hr.shift_assignment where shift_id = $1`, [shift]);
    await asMigrator(`delete from hr.shift where id = $1`, [shift]);
  });

  test('worked 07:00–19:00 on an 08:00–20:00 shift: an hour extra before, and left an hour early', async ({
    page,
  }) => {
    await signInAs(page, NAME);
    await page.goto('/roster/my');
    const past = page.getByTestId('my-shifts-past');
    const day = past.getByTestId('shift-day').first();
    const rows = day.getByTestId('shift-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-kind', 'extra_before');
    await expect(rows.nth(0)).toContainText('Extra before shift');
    await expect(rows.nth(0).getByTestId('shift-in-out')).toHaveText('In 07:00 · Out 08:00');
    await expect(rows.nth(1)).toContainText('08:00–20:00');
    await expect(rows.nth(1).getByTestId('shift-in-out')).toHaveText('In 08:00 · Out 19:00');
    await expect(rows.nth(1).getByTestId('shift-status')).toHaveText('Left 1 h early');

    await page.goto('/roster/clock');
    await expect(page.getByTestId('past-session').first()).toContainText('In 07:00 · Out 19:00');
    await expect(page.getByTestId('past-session').first()).toContainText('12 h');
  });
});
