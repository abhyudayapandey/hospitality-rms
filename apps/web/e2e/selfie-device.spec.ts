import { expect, test } from '@playwright/test';
import { asMigrator, placeId, PLACE, signInAs } from './helpers';

// Clock-in selfie and device (ATT-7; ADR 045) through the real screens. Photos are kept on this
// machine here (PHOTO_DIR, ADR 127), so the selfie goes with the punch. Who sees a selfie, a
// clock-in with none (flagged), new and shared devices, the offline selfie and the retention
// are in selfie-device.db.test.ts.

const AT_BAR = { latitude: 12.9716, longitude: 77.5946 };

async function clockOutIfIn(page: import('@playwright/test').Page) {
  await page.goto('/roster/clock');
  await expect(page.getByTestId('clock-state')).toBeVisible();
  const out = page.getByRole('button', { name: 'Clock out' });
  if (await out.isVisible()) {
    await expect(out).toBeEnabled();
    await out.click();
    await expect(page.getByRole('button', { name: 'Clock in with a selfie' })).toBeVisible();
  }
}

test('a selfie taken at clock-in goes with the punch', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(AT_BAR);
  await signInAs(page, 'Test Server 3.0');
  await clockOutIfIn(page);
  // the page is live once its button is (ADR 055)
  await expect(page.getByRole('button', { name: 'Clock in with a selfie' })).toBeEnabled();

  // the live camera opens (a fake one here; never the gallery), and the punch follows the photo
  await page.getByRole('button', { name: 'Clock in with a selfie' }).click();
  await expect(page.getByTestId('selfie-camera')).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Take photo and clock in' }).click();
  await expect(page.getByTestId('clock-state')).toContainText('Clocked in since');
  await expect(page.getByRole('status')).toContainText('Clocked in at');
  // the selfie was kept: nothing to flag
  await expect(page.getByRole('status')).not.toContainText('No selfie');
  const [selfie] = await asMigrator<{ selfie_key: string | null }>(
    `select s.selfie_key from hr.attendance_selfie s join core.app_user u on u.id = s.owner_user_id
      where u.username = 'test.server.3.0' order by s.created_at desc limit 1`,
    [],
  );
  expect(selfie?.selfie_key).toMatch(/^selfies\//);

  await signInAs(page, 'Test Server 3.0');
  await clockOutIfIn(page);
});

test('one phone used to clock in for two people the same day is flagged for the department head', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(AT_BAR);
  // the same browser (and so the same device id) for both
  for (const who of ['Test Server 3.0', 'Test Server B 3.0']) {
    await signInAs(page, who);
    await clockOutIfIn(page);
    await page.getByTestId('clock-no-selfie').click();
    await expect(page.getByTestId('clock-state')).toContainText('Clocked in since');
  }
  // a device id was kept in this browser
  expect(await page.evaluate(() => localStorage.getItem('oo-device-id'))).toMatch(
    /^[0-9a-f-]{36}$/,
  );

  await signInAs(page, 'Test Floor Manager 3.0');
  await page.goto(`/roster/exceptions?node=${await placeId(PLACE.floor)}`);
  const shared = page.getByTestId('exceptions').locator('li').filter({ hasText: 'Shared phone' });
  await expect(shared.filter({ hasText: 'Test Server 3.0' }).first()).toBeVisible();
  await expect(shared.filter({ hasText: 'Test Server B 3.0' }).first()).toBeVisible();

  for (const who of ['Test Server 3.0', 'Test Server B 3.0']) {
    await signInAs(page, who);
    await clockOutIfIn(page);
  }
  await asMigrator(`select 1`, []);
});
