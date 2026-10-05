import { expect, test } from '@playwright/test';
import { PHOTO_MAX_SIDE, PHOTO_QUALITY, resizePhoto } from '../lib/photo-resize';
import { placeId, signInAs, viewing, viewingOptions } from './helpers';

// The "Place:" switcher (ADR 016): each screen lists only its own kind of place, with the
// most useful one first and the last choice remembered per screen.

test('the general manager sees only stores on Stock and only departments on Roster', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/stock');
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – Main Store');
  expect(await viewingOptions(page)).toEqual([
    'All stores', // first, for every list that spans stores (ADR 038)
    'Test Hotel & Bar 1.0 – Main Store',
    'Test Hotel & Bar 1.0 – Bar Store',
    'Test Hotel & Bar 1.0 – Housekeeping Store',
    'Test Hotel & Bar 1.0 – Kitchen Store',
  ]);

  await page.goto('/roster/week');
  const options = await viewingOptions(page);
  expect(options[0]).toBe('All departments');
  const departments = options.slice(1);
  expect(departments.length).toBe(10);
  for (const d of departments) {
    expect(d).toMatch(/^Test Hotel & Bar 1\.0 – /);
    expect(d).not.toMatch(/Store$/); // no stores among people places
  }
  expect(departments).toContain('Test Hotel & Bar 1.0 – Kitchen');
  // the GM's home (the outlet) isn't a roster place: Roster opens on a department with
  // shifts, not the first one alphabetically (UX U-7)
  await expect.poll(() => viewing(page)).not.toBe('Test Hotel & Bar 1.0 – Admin & Finance');
  await expect(page.getByTestId('week-summary')).not.toHaveText(/^0 shifts/);
});

test('reporting a problem starts where you work, with a way to pick elsewhere (UX U-8)', async ({
  page,
}) => {
  await signInAs(page, 'Test Commis 1.0');
  await page.goto('/tasks/maintenance/new');
  const bar = page.getByTestId('place-switcher');
  await expect(bar.getByTestId('viewing')).toHaveText('Test Hotel & Bar 1.0 – Kitchen');
  await expect(bar.getByRole('combobox', { name: 'Place' })).toHaveCount(0);
  await bar.getByRole('button', { name: 'Change' }).click();
  await expect(bar.getByRole('combobox', { name: 'Place' })).toBeVisible();
});

test('the choice is remembered per screen, and tabs carry the place where it fits', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/stock');
  const picker = page.getByRole('combobox', { name: 'Place' });
  // inside one outlet the options read "Kitchen Store", not the outlet again (UX U-5)
  await expect(picker.locator('option:checked')).toHaveText('Main Store');
  await picker.selectOption(await placeId('TEST-HOTEL-1.0-KITCHEN-STORE'));
  await page.waitForURL(new RegExp(`node=${await placeId('TEST-HOTEL-1.0-KITCHEN-STORE')}`));
  await expect(page.getByTestId('stock-row').first()).toBeVisible();
  // back to Stock without ?node=: the remembered store
  await page.goto('/stock');
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – Kitchen Store');
  // the Orders tab keeps the store
  await page
    .getByRole('navigation', { name: 'Supply' })
    .getByRole('link', { name: 'Orders' })
    .click();
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – Kitchen Store');
  // another screen keeps its own default: stock position opens on all the outlet's stores
  // (RPT-14, ADR 033)
  await page.goto('/reports/stock');
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – All stores');
  // put Stock back for the other tests
  await page.goto('/stock');
  await page
    .getByRole('combobox', { name: 'Place' })
    .selectOption(await placeId('TEST-HOTEL-1.0-MAIN-STORE'));
  await page.waitForURL(new RegExp(`node=${await placeId('TEST-HOTEL-1.0-MAIN-STORE')}`));
});

test('a bartender sees no switcher on Stock and only the Bar Store on Production', async ({
  page,
}) => {
  await signInAs(page, 'Test Bartender 1.0');
  await page.goto('/stock');
  await expect(page.getByRole('main')).toContainText("You don't have access to stock.");
  await expect(page.getByTestId('place-switcher')).toHaveCount(0);
  await page.goto('/stock/production');
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – Bar Store');
  expect(await viewingOptions(page)).toEqual([]);
});

test('a commis sees only the Kitchen Store on Make, and no other stock screen', async ({
  page,
}) => {
  await signInAs(page, 'Test Commis 1.0');
  // Make is one of the commis's four tiles on Home (UX-6)
  await page.getByTestId('tile-make').click();
  await page.waitForURL(/\/stock\/production/);
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – Kitchen Store');
  expect(await viewingOptions(page)).toEqual([]);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Make' })).toBeVisible();
  // production only: no stock tabs; an expired batch is reported to the lead, not wasted
  await expect(page.getByRole('navigation', { name: 'Supply' })).toHaveCount(0);
  await expect(main.getByRole('link', { name: /record the wastage/ })).toHaveCount(0);
  await expect(page.getByTestId('expired').getByRole('button', { name: 'Report' })).not.toHaveCount(
    0,
  );
  await expect(main.getByRole('link', { name: 'Mint Chutney' })).toBeVisible();
});

test('an area manager sees outlets on Menu', async ({ page }) => {
  await signInAs(page, 'Test Area Manager');
  await page.goto('/menu');
  const outlets = await viewingOptions(page);
  expect(outlets.length).toBeGreaterThan(1);
  for (const o of outlets) expect(o).not.toContain('–'); // outlets, not stores or departments
  expect(outlets).toContain('Test Hotel & Bar 1.0');
});

test('no switcher on single-outlet Menu, Inbox, Requests or Home', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0');
  for (const path of ['/menu', '/inbox', '/requests', '/']) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByTestId('place-switcher'), path).toHaveCount(0);
  }
});

test('events: the Executive Chef cannot plan one; the Banquet Manager plans it for the outlet', async ({
  page,
}) => {
  await signInAs(page, 'Test Executive Chef 1.0');
  await page.goto('/events');
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0');
  await expect(page.getByRole('link', { name: 'New event' })).toHaveCount(0);

  const name = `E2E banquet ${Date.now()}`;
  await signInAs(page, 'Test Banquet Manager 1.0');
  await page.goto('/events');
  await page.getByRole('link', { name: 'New event' }).click();
  await expect(
    page.getByRole('heading', { name: 'New event · Test Hotel & Bar 1.0' }),
  ).toBeVisible();
  const form = page.getByRole('form', { name: 'Event' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Covers').fill('60');
  await form.getByRole('button', { name: 'Create event' }).click();
  await page.waitForURL(/\/events\/[0-9a-f-]{36}/);

  // the whole outlet reads it: a commis in the kitchen
  await signInAs(page, 'Test Commis 1.0');
  await page.goto('/events');
  await expect(page.getByTestId('events')).toContainText(name);
});

test('photos are shrunk on the phone before upload: long side 1280 px, a few hundred KB', async ({
  page,
}) => {
  await page.goto('about:blank');
  // the exact function the wastage form uses, in the browser
  await page.addScriptTag({ content: `window.resizePhoto = ${resizePhoto.toString()};` });
  const r = await page.evaluate(
    async ({ maxSide, quality }) => {
      const resize = (
        window as unknown as { resizePhoto: (f: Blob, m: number, q: number) => Promise<Blob> }
      ).resizePhoto;
      // a 12 MP camera-like frame (4000 x 3000): light and shade, edges, and sensor noise
      const canvas = document.createElement('canvas');
      canvas.width = 4000;
      canvas.height = 3000;
      const g = canvas.getContext('2d')!;
      const sky = g.createLinearGradient(0, 0, 0, 3000);
      sky.addColorStop(0, '#d8c7a4');
      sky.addColorStop(1, '#5b4632');
      g.fillStyle = sky;
      g.fillRect(0, 0, 4000, 3000);
      for (let i = 0; i < 120; i++) {
        g.fillStyle = `hsl(${(i * 37) % 360} 45% ${30 + (i % 40)}%)`;
        g.beginPath();
        g.arc((i * 331) % 4000, (i * 517) % 3000, 60 + ((i * 13) % 240), 0, Math.PI * 2);
        g.fill();
      }
      const img = g.getImageData(0, 0, 4000, 3000);
      const px = img.data;
      let seed = 7;
      for (let p = 0; p < px.length; p += 4) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        const n = ((seed >>> 24) % 25) - 12;
        px[p] = px[p]! + n;
        px[p + 1] = px[p + 1]! + n;
        px[p + 2] = px[p + 2]! + n;
      }
      g.putImageData(img, 0, 0);
      const original = await new Promise<Blob>((ok) =>
        canvas.toBlob((b) => ok(b!), 'image/jpeg', 0.92),
      );
      const small = await resize(original, maxSide, quality);
      const bitmap = await createImageBitmap(small);
      return {
        originalBytes: original.size,
        bytes: small.size,
        type: small.type,
        width: bitmap.width,
        height: bitmap.height,
      };
    },
    { maxSide: PHOTO_MAX_SIDE, quality: PHOTO_QUALITY },
  );
  test.info().annotations.push({
    type: 'photo size',
    description: `12 MP JPEG ${Math.round(r.originalBytes / 1024)} KB -> ${r.width}x${r.height} ${Math.round(r.bytes / 1024)} KB`,
  });
  console.log(
    `photo: ${Math.round(r.originalBytes / 1024)} KB at 4000x3000 -> ${Math.round(r.bytes / 1024)} KB at ${r.width}x${r.height}`,
  );
  expect(r.type).toBe('image/jpeg');
  expect([r.width, r.height]).toEqual([1280, 960]);
  expect(r.bytes).toBeLessThan(600 * 1024);
  expect(r.bytes).toBeLessThan(r.originalBytes / 4);
});
