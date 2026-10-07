import { expect, test, type Page } from '@playwright/test';
import { asMigrator, runPlatformWorker, signInPlatform } from './helpers';

// The set-up wizard (ADR 064) at 380 px, through the real screens and the real worker: a café
// company from nothing, left half way and resumed, one role covered and one not done, people
// typed and pasted, par on its stock, a bundle they don't buy, then the two taps of Go live and
// the printed login sheet.

test.use({ viewport: { width: 380, height: 900 } });

async function next(page: Page) {
  await page.getByRole('button', { name: 'Next', exact: true }).click();
}

async function workerUntil(page: Page, stage: string) {
  for (let i = 0; i < 6; i++) {
    runPlatformWorker();
    const now = await page.getByTestId('go-live').getAttribute('data-stage');
    if (now === stage) return;
    await page.waitForTimeout(2500); // the page polls every 2 s and moves on by itself
  }
  await expect(page.getByTestId('go-live')).toHaveAttribute('data-stage', stage);
}

test('a café company from nothing to live, resumed half way', async ({ page }) => {
  const stamp = Date.now().toString(36).toUpperCase();
  const company = `Wizard Cafés ${stamp}`;
  const code = `WIZ-${stamp}`;
  await signInPlatform(page);
  await page.goto('/platform');
  await page.getByRole('button', { name: 'Set up a new customer' }).click();
  await page.waitForURL(/\/platform\/setup\/[0-9a-f-]{36}\/company$/);
  const draftUrl = page.url().replace(/\/company$/, '');

  // 1. company
  const c = page.getByRole('form', { name: 'Company' });
  await c.getByLabel('Company name').fill(company);
  await c.getByLabel(/Short name for logins/).fill(code);
  await c.getByLabel("Owner's name").fill('Asha Rao');
  await c.getByLabel("Owner's email").fill(`${code.toLowerCase()}@example.test`);
  await c.getByLabel(/A demo or test company/).check();
  await next(page);

  // 2. outlets: a tile, a name, an extra
  await page.getByTestId('tiles').getByRole('link', { name: /Café/ }).click();
  const o = page.getByRole('form', { name: 'The outlet' });
  await o.getByLabel('Name', { exact: true }).fill('Bandra Café');
  await o.getByRole('checkbox', { name: /Takes delivery orders/ }).check();
  await o.getByRole('button', { name: 'Save outlet' }).click();
  await expect(page.getByTestId('outlets')).toContainText('Bandra Café');
  // Change and Remove: two equal buttons side by side
  const card = page.getByTestId('outlets').locator('[data-outlet="Bandra Café"]');
  const change = await card.getByRole('link', { name: 'Change' }).boundingBox();
  const remove = await card.getByRole('button', { name: /Remove/ }).boundingBox();
  expect(Math.abs(change!.width - remove!.width)).toBeLessThan(2);
  expect(Math.abs(change!.y - remove!.y)).toBeLessThan(2);

  // left half way: the console lists it, and it opens where it was left
  await page.goto('/platform');
  await page
    .getByTestId('setups')
    .getByRole('link', { name: new RegExp(company) })
    .click();
  await expect(page).toHaveURL(new RegExp(`${draftUrl}/outlets`));
  await next(page);

  // 3. departments: a café's own first; the dining room offered, unticked
  const depts = page.getByTestId('departments-Bandra Café');
  await expect(depts.getByRole('checkbox', { name: 'Counter' })).toBeChecked();
  await expect(depts.getByText('Also in a restaurant')).toBeVisible();
  await next(page);

  // 4. roles: the manager covers the head cook; no kitchen steward
  const roles = page.getByTestId('roles-Bandra Café');
  const head = roles.locator('[data-role="Head Cook"]');
  await head.getByRole('radio', { name: 'Someone else does it' }).check();
  await head.getByLabel('Who does it instead').selectOption({ label: 'Restaurant Manager' });
  await roles
    .locator('[data-role="Kitchen Steward"]')
    .getByRole('radio', { name: "We don't do this" })
    .check();
  await page.getByRole('button', { name: 'Back' }).click(); // saved on Back too
  await next(page);
  await expect(page.getByTestId('what-moves')).toContainText(
    "The Restaurant Manager also does the Head Cook's work",
  );
  await next(page);

  // 5. people: typed and pasted; a role that isn't one is caught
  const people = page.getByTestId('person');
  await people.nth(0).getByLabel('Name').fill('Meera Shah');
  await people
    .nth(0)
    .getByLabel('Email (optional)')
    .fill(`meera.${stamp.toLowerCase()}@example.test`);
  await people.nth(0).getByLabel('Role').selectOption({ label: 'Restaurant Manager' });
  await people.nth(0).getByLabel('Works at').selectOption({ label: 'Bandra Café' });
  await page
    .getByLabel(/Or paste from a sheet/)
    .fill('Ravi Kumar, , Barista, Bandra Café\nSunil, , Cok, Bandra Café');
  await page.getByRole('button', { name: 'Save and add more' }).click();
  await expect(page.getByTestId('notes')).toContainText('no role called Cok: did you mean Cook?');
  await people.nth(2).getByLabel('Role').selectOption({ label: 'Cook' });
  await page.getByRole('button', { name: 'Save and add more' }).click();
  await expect(page.getByTestId('login-summary')).toHaveText('1 by email · 2 on the printed sheet');
  await next(page);

  // 6. stock: par on milk, no salt
  const stock = page.getByTestId('stock-Bandra Café');
  await stock.getByLabel('Par for Milk').fill('12');
  await stock.locator('[data-item="Salt"]').getByRole('checkbox').uncheck();
  await next(page);

  // 7. who does what, then Go live in two taps
  const who = page.getByTestId('who-Bandra Café');
  await expect(who.locator('[data-role="Head Cook"]')).toContainText(
    'The Restaurant Manager (Meera Shah)',
  );
  await expect(who.locator('[data-role="Kitchen Steward"]')).toContainText('Not done here');
  // what they buy (ADR 067): the bundles the café uses, ticked; they don't buy People & roster
  const buys = page.getByRole('form', { name: 'What they buy' });
  for (const b of ['Stock & cost', 'People & roster', 'Tasks & food safety']) {
    await expect(buys.getByRole('checkbox', { name: new RegExp(b) })).toBeChecked();
  }
  await buys.getByRole('checkbox', { name: /People & roster/ }).uncheck();
  await buys.getByRole('button', { name: 'Save what they buy' }).click();
  await expect(
    page.getByRole('form', { name: 'What they buy' }).getByRole('checkbox', { name: /People/ }),
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'Check everything' }).click();
  await workerUntil(page, 'checked');
  // the check's warnings in names, never codes, and they don't block
  const warnings = page.getByTestId('check-warnings');
  await expect(warnings).toContainText("these don't stop you going live");
  await expect(warnings).toContainText("Asha Rao's own");
  await expect(warnings).not.toContainText(/[A-Z]{2,}_[A-Z]|wiz-/i);
  await expect(page.getByTestId('check-warnings')).toContainText(
    "Bandra Café uses Leave and Shift swaps, part of People & roster, which isn't on for this customer",
  );
  await page.getByRole('button', { name: 'Looks right: apply and send logins' }).click();
  await workerUntil(page, 'live');
  await expect(page.getByTestId('live')).toBeVisible();

  // the printed sheet: login IDs and one-time passwords, made in the browser
  const ids = page.getByTestId('login-ids');
  await ids.getByRole('button', { name: 'Create 2 username logins' }).click();
  const [sheet] = await Promise.all([
    page.waitForEvent('popup'),
    ids.getByRole('button', { name: 'Print the login sheet' }).click(),
  ]);
  await expect(sheet.locator('table')).toContainText(`${code.toLowerCase()}.ravi.kumar`);
  await expect(sheet.locator('h1')).toContainText(company);

  // what was loaded
  const loaded = await asMigrator<{ username: string; home: string }>(
    `select u.username, n.code as home from core.app_user u
       join core.tenant t on t.id = u.tenant_id
       join hr.worker w on w.owner_user_id = u.id
       join core.hierarchy_node n on n.id = w.org_node_id
      where t.code = $1 and u.kind = 'human' order by 1`,
    [code],
  );
  expect(loaded.map((u) => u.username)).toEqual([
    `${code.toLowerCase()}.meera.shah`,
    `${code.toLowerCase()}.owner`,
    `${code.toLowerCase()}.ravi.kumar`,
    `${code.toLowerCase()}.sunil`,
  ]);
  const cover = await asMigrator<{ job_role_code: string; mode: string }>(
    `select rc.job_role_code, rc.mode from hr.role_cover rc join core.tenant t on t.id = rc.tenant_id
      where t.code = $1 and rc.archived_at is null order by 1`,
    [code],
  );
  expect(cover).toEqual([
    { job_role_code: 'HEAD_COOK', mode: 'covered_by' },
    { job_role_code: 'KITCHEN_STEWARD', mode: 'not_done' },
  ]);
  // Go live put the ticked bundles in the plan and left People & roster out
  const plan = await asMigrator<{ b: unknown }>(
    `select settings -> 'bundles' as b from core.tenant where code = $1`,
    [code],
  );
  expect(plan[0]!.b).toEqual({ people_roster: false });
  const par = await asMigrator<{ par: string }>(
    `select l.par_level::text par from inv.item_node l
       join inv.item i on i.id = l.item_id join core.tenant t on t.id = i.tenant_id
      where t.code = $1 and i.sku = 'MILK'`,
    [code],
  );
  expect(par.map((p) => Number(p.par))).toEqual([12]);
});

test('a set-up can be thrown away, from its screens or from the list', async ({ page }) => {
  const stamp = Date.now().toString(36).toUpperCase();
  await signInPlatform(page);
  for (const where of ['wizard', 'list'] as const) {
    const company = `Thrown ${where} ${stamp}`;
    await page.goto('/platform');
    await page.getByRole('button', { name: 'Set up a new customer' }).click();
    await page.waitForURL(/\/company$/);
    await page.getByRole('form', { name: 'Company' }).getByLabel('Company name').fill(company);
    await next(page);
    await page.waitForURL(/\/outlets$/);
    if (where === 'list') await page.goto('/platform');
    const scope = where === 'list' ? page.locator(`[data-setup="${company}"]`) : page;
    await scope.getByRole('button', { name: /Throw away/ }).click();
    // two taps: the first asks, and Keep it leaves it be
    const ask = page.getByRole('group', { name: 'Throw away this set-up?' });
    await expect(ask).toContainText(`Throw away the set-up of ${company}?`);
    await ask.getByRole('button', { name: 'Yes, throw it away' }).click();
    await page.waitForURL(/\/platform$/);
    await expect(page.getByText(company)).toHaveCount(0);
  }
});
