import { expect, test } from '@playwright/test';
import { signInAs, viewing, viewingOptions } from './helpers';

// Quick fixes from prospect feedback (ADR 033) on the test data: Needs attention by
// department, the expiry banners and lists, stock position for all of an outlet's stores,
// and menu engineering over months. The figures and every refusal are pinned by the DB
// tests (department-order, expiry, wastage-notify, cost-reports); here, what people see.

/** The order Home groups departments in (DB-2): Kitchen, service, housekeeping, the rest. */
const ORDER = [
  'Kitchen',
  'Bar',
  'Banquets',
  'Restaurant',
  'Housekeeping',
  'Admin & Finance',
  'Engineering',
  'Front Office',
  'Security',
  'Stores Team',
  'Whole outlet',
];

test('the GM: Needs attention by department, Kitchen first', async ({ page }) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/');
  const groups = page.getByTestId('attention-card').getByTestId('attention-group');
  await expect(groups.first()).toBeVisible();
  const labels = await groups.evaluateAll((gs) => gs.map((g) => g.getAttribute('aria-label')));
  expect(labels.length).toBeGreaterThan(1);
  expect(labels[0]).toBe('Kitchen');
  const ranks = labels.map((l) => ORDER.indexOf(l ?? ''));
  expect(ranks.every((r) => r >= 0)).toBe(true);
  // kitchen first, then service (Bar, Banquets, Restaurant), then housekeeping, the rest
  const kind = (l: string) =>
    l === 'Kitchen'
      ? 1
      : ['Bar', 'Banquets', 'Restaurant'].includes(l)
        ? 2
        : l === 'Housekeeping'
          ? 3
          : l === 'Whole outlet'
            ? 5
            : 4;
  const kinds = labels.map((l) => kind(l!));
  expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
});

test('the executive chef: the expiry banners open their lists', async ({ page }) => {
  await signInAs(page, 'Test Executive Chef 1.0');
  // the banners are on Home; they open the Expiring and Expired tabs of Stock (ADR 048)
  await page.goto('/');
  await expect(page.getByTestId('banner-expiring')).toContainText('Items expiring within 3 days');
  await expect(page.getByTestId('banner-expired')).toContainText('Expired items');

  await page.getByTestId('banner-expiring').click();
  const soon = page.getByTestId('expiry-expiring');
  await expect(soon.locator('[data-sku="GINGER-GARLIC-PASTE"]')).toContainText('580 g left');
  await expect(soon.locator('[data-sku="MINT-CHUTNEY"]')).toHaveCount(0);

  await page.getByRole('link', { name: /^Expired/ }).click();
  const gone = page.getByTestId('expiry-expired');
  await expect(gone.locator('[data-sku="MINT-CHUTNEY"]')).toContainText('140 g left');
  // the executive chef throws it away through Wastage, which tells the GM (NT-2)
  await expect(gone.getByRole('link', { name: 'Throw away' })).toHaveAttribute(
    'href',
    /\/stock\/wastage\?.*reason=expired/,
  );
});

test('stock position: all of the outlet’s stores, with expired and expiring values', async ({
  page,
}) => {
  await signInAs(page, 'Test General Manager 1.0');
  await page.goto('/reports/stock');
  // the GM opens on all of the outlet's stores
  await expect.poll(() => viewing(page)).toBe('Test Hotel & Bar 1.0 – All stores');
  await expect.poll(() => viewingOptions(page)).toContain('Test Hotel & Bar 1.0 – Kitchen Store');
  await expect(page.getByTestId('measure-expired_stock_value').getByTestId('value')).toHaveText(
    '₹25',
  );
  const dated = page.getByTestId('expiry-items');
  await expect(dated.locator('[data-sku="MINT-CHUTNEY"]')).toContainText(
    'Test Hotel & Bar 1.0 – Kitchen Store',
  );
  await expect(dated.locator('[data-sku="SOUR-MIX"]')).toContainText('expiring');
});

test('menu engineering: 3 to 12 months, in plain words', async ({ page }) => {
  await signInAs(page, 'Test Cost Controller 1.0');
  await page.goto('/reports/menu');
  const period = page.getByRole('navigation', { name: 'Period' });
  await expect(period.getByRole('link', { name: '3 months' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await period.getByRole('link', { name: '12 months' }).click();
  await expect(period.getByRole('link', { name: '12 months' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const gin = page.locator('section[data-menu="Bar"] [data-code="GIN-AND-TONIC"]');
  await expect(gin.getByTestId('dish-money')).toHaveText(
    /^Price ₹.+ · cost ₹.+ · margin ₹.+ a serve$/,
  );
  await expect(gin.getByTestId('dish-share')).toHaveText(/^\d+ sold · [\d.]+% of drinks sold$/);
});
