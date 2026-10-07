import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { asMigrator, runPlatformWorker, signInPlatform } from './helpers';

// The final pass of docs/templates-and-cover.md at 380 px, through the real wizard screens and
// the real worker (ADR 064):
// 1. every tile in one company, each extra used once, through the check and live: the
//    bundles they use ticked on "What they buy" (Compliance offered, unticked), "who does
//    what" on the review, warnings in words, then the outlets' formats, departments and
//    starter checklists as loaded;
// 2. a café, a bar and a hotel set up from nothing, timed: taps, fields typed and seconds per
//    step, appended to test-results/setup-timings.jsonl (docs/templates-and-cover.md has the
//    table). The café's own walk (resume, cover, paste, par, bundles) is setup-wizard.spec.ts.

test.use({ viewport: { width: 380, height: 900 } });

/** Counts what a person does: taps and fields typed. */
class Walk {
  taps = 0;
  fields = 0;
  private started = Date.now();
  private mark = Date.now();
  readonly steps: Record<string, number> = {};
  constructor(readonly page: Page) {}
  async tap(l: ReturnType<Page['getByRole']>) {
    this.taps++;
    await l.click();
  }
  async type(l: ReturnType<Page['getByRole']>, v: string) {
    this.fields++;
    await l.fill(v);
  }
  async check(l: ReturnType<Page['getByRole']>) {
    this.taps++;
    await l.check();
  }
  async next() {
    await this.tap(this.page.getByRole('button', { name: 'Next', exact: true }));
  }
  step(name: string) {
    const now = Date.now();
    this.steps[name] = Math.round((now - this.mark) / 100) / 10;
    this.mark = now;
  }
  get seconds() {
    return Math.round((Date.now() - this.started) / 100) / 10;
  }
}

async function workerUntil(page: Page, stage: string) {
  for (let i = 0; i < 8; i++) {
    runPlatformWorker();
    const now = await page.getByTestId('go-live').getAttribute('data-stage');
    if (now === stage) return;
    await page.waitForTimeout(2500); // the page polls every 2 s and moves on by itself
  }
  await expect(page.getByTestId('go-live')).toHaveAttribute('data-stage', stage);
}

interface OutletSpec {
  tile: RegExp;
  name: string;
  /** extras to tick beyond the tile's defaults */
  extras?: RegExp[];
}

/** From the console to a draft with its company filled in. */
async function startCompany(w: Walk, company: string, code: string) {
  const page = w.page;
  await signInPlatform(page);
  await page.goto('/platform');
  w.step('sign in');
  await w.tap(page.getByRole('button', { name: 'Set up a new customer' }));
  await page.waitForURL(/\/platform\/setup\/[0-9a-f-]{36}\/company$/);
  const c = page.getByRole('form', { name: 'Company' });
  await w.type(c.getByLabel('Company name'), company);
  await w.type(c.getByLabel(/Short name for logins/), code);
  await w.type(c.getByLabel("Owner's name"), 'Asha Rao');
  await w.type(c.getByLabel("Owner's email"), `${code.toLowerCase()}@example.test`);
  await w.check(c.getByLabel(/A demo or test company/));
  await w.next();
  w.step('company');
}

async function addOutlets(w: Walk, outlets: OutletSpec[]) {
  const page = w.page;
  for (const [i, o] of outlets.entries()) {
    if (i > 0) await w.tap(page.getByTestId('add-outlet'));
    await w.tap(page.getByTestId('tiles').getByRole('link', { name: o.tile }));
    const f = page.getByRole('form', { name: 'The outlet' });
    await w.type(f.getByLabel('Name', { exact: true }), o.name);
    for (const x of o.extras ?? []) await w.check(f.getByRole('checkbox', { name: x }));
    await w.tap(f.getByRole('button', { name: 'Save outlet' }));
    await expect(page.getByTestId('outlets')).toContainText(o.name);
  }
  await w.next();
  w.step('outlets');
}

/** What they buy (ADR 067, 069): the bundles their outlets use come ticked. */
async function bundles(w: Walk, usual: string[]) {
  const page = w.page;
  const ticked = page.getByTestId('bundles-usual');
  for (const b of usual) {
    await expect(ticked.getByRole('checkbox', { name: new RegExp(b) })).toBeChecked();
  }
  await expect(
    page.getByTestId('bundles-more').getByRole('checkbox', { name: /Compliance/ }),
  ).not.toBeChecked();
  await w.next();
  w.step('bundles');
}

const USUAL = ['Stock & cost', 'People & roster', 'Tasks & food safety'];

/** Departments, roles and stock as the template offers them; people pasted. */
async function defaults(w: Walk, people: string) {
  const page = w.page;
  await expect(page.locator('[data-testid^="departments-"]').first()).toBeVisible();
  await w.next();
  w.step('departments');
  await expect(page.locator('[data-testid^="roles-"]').first()).toBeVisible();
  await w.next();
  // a second roles page says what moves when there is cover; none here
  await page.waitForURL(/\/(roles|people)(\?.*)?$/);
  if (!page.url().match(/\/people(\?.*)?$/)) await w.next();
  await page.waitForURL(/\/people(\?.*)?$/);
  w.step('roles');
  await w.type(page.getByLabel(/Or paste from a sheet/), people);
  await w.tap(page.getByRole('button', { name: 'Save and add more' }));
  await expect(page.getByTestId('notes')).toHaveCount(0);
  await w.next();
  w.step('people');
  await expect(page.locator('[data-testid^="stock-"]').first()).toBeVisible();
  await w.next();
  w.step('stock');
}

async function checkAndGoLive(w: Walk) {
  const page = w.page;
  await w.tap(page.getByRole('button', { name: 'Check everything' }));
  await workerUntil(page, 'checked');
  await expect(page.getByTestId('checked')).toContainText('no problems');
  // warnings, if any, are words: never a code or a login prefix
  const warnings = page.getByTestId('check-warnings');
  if (await warnings.isVisible()) {
    await expect(warnings).not.toContainText(/[A-Z]{2,}_[A-Z]|[a-z]_[a-z]+_/);
  }
  w.step('check');
  await w.tap(page.getByRole('button', { name: 'Looks right: apply and send logins' }));
  await workerUntil(page, 'live');
  await expect(page.getByTestId('live')).toBeVisible();
  w.step('go live');
}

const stamp = () => Date.now().toString(36).toUpperCase().slice(-6);

test('every tile and extra, in one company, to live', async ({ page }) => {
  test.setTimeout(300_000);
  const s = stamp();
  const code = `TPL-${s}`;
  const w = new Walk(page);
  await startCompany(w, `Template Walk ${s}`, code);
  const outlets: (OutletSpec & { format: string })[] = [
    {
      tile: /Restaurant only/,
      name: 'Juhu Restaurant',
      extras: [/Banquets/],
      format: 'restaurant',
    },
    // the bar comes ticked with Restaurant + Bar
    { tile: /Restaurant \+ Bar/, name: 'Colaba Bistro', extras: [/Brews/], format: 'restaurant' },
    { tile: /Bar \/ Pub/, name: 'Andheri Pub', extras: [/delivery/], format: 'bar_pub' },
    { tile: /Café/, name: 'Bandra Café', extras: [/Cooks for our other/], format: 'restaurant' },
    { tile: /Quick service/, name: 'Powai Express', extras: [/delivery/], format: 'qsr' },
    { tile: /Delivery-only/, name: 'Worli Cloud Kitchen', format: 'cloud_kitchen' },
    {
      tile: /Hotel/,
      name: 'Sea View Hotel',
      extras: [/A bar/, /Banquets/, /swimming pool/, /A spa/, /A gym/],
      format: 'hotel',
    },
  ];
  await addOutlets(w, outlets);
  await bundles(w, USUAL);
  await defaults(
    w,
    [
      'Meera Shah, , General Manager, Sea View Hotel',
      'Ravi Kumar, , Head Cook, Bandra Café',
      'Sunil Rao, , Bar Manager, Andheri Pub',
    ].join('\n'),
  );

  // the review: who does what for each outlet, and what they buy as chosen
  for (const o of outlets) await expect(page.getByTestId(`who-${o.name}`)).toBeVisible();
  await expect(page.getByTestId('bundles')).toContainText(USUAL.join(', '));
  await checkAndGoLive(w);

  // as loaded: each outlet's format, its departments and its starter checklists
  const loaded = await asMigrator<{ name: string; format: string; depts: number; lists: number }>(
    `select o.name, o.outlet_format as format,
            (select count(*)::int from core.hierarchy_node d
              where d.parent_id = o.id and d.kind = 'department') as depts,
            (select count(*)::int from ops.checklist_template ct
               join core.hierarchy_node n on n.id = ct.org_node_id
              where n.path operator(extensions.<@) o.path) as lists
       from core.hierarchy_node o join core.tenant t on t.id = o.tenant_id
      where t.code = $1 and o.type = 'org' and o.kind = 'outlet' order by o.name`,
    [code],
  );
  expect(loaded.map((o) => [o.name, o.format])).toEqual(
    outlets.map((o) => [o.name, o.format]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
  );
  for (const o of loaded) {
    expect(o.depts, o.name).toBeGreaterThan(0);
    expect(o.lists, o.name).toBeGreaterThan(0);
  }
  // every extra made its department or site
  const places = await asMigrator<{ name: string }>(
    `select n.name from core.hierarchy_node n join core.tenant t on t.id = n.tenant_id
      where t.code = $1 and n.type = 'org' order by 1`,
    [code],
  );
  const names = places.map((p) => p.name).join(' | ');
  for (const p of [
    'Juhu Restaurant – Banquets',
    'Colaba Bistro – Bar',
    'Colaba Bistro – Brewhouse',
    'Sea View Hotel – Bar',
    'Sea View Hotel – Banquets',
  ]) {
    expect(names).toContain(p);
  }
  expect(names).toMatch(/Central Kitchen|Production/);
  const plan = await asMigrator<{ b: unknown }>(
    `select settings -> 'bundles' as b from core.tenant where code = $1`,
    [code],
  );
  expect(plan[0]!.b ?? {}).toEqual({});
});

for (const t of [
  { kind: 'café', tile: /Café/, name: 'Khar Café', manager: 'Restaurant Manager', role: 'Barista' },
  {
    kind: 'bar',
    tile: /Bar \/ Pub/,
    name: 'Bandra Pub',
    manager: 'Bar Manager',
    role: 'Bartender',
  },
  {
    kind: 'hotel',
    tile: /Hotel/,
    name: 'Lake View Hotel',
    manager: 'General Manager',
    role: 'Front Desk Executive',
  },
]) {
  test(`a ${t.kind} from nothing, timed`, async ({ page }) => {
    test.setTimeout(240_000);
    const s = stamp();
    const code = `TIME-${s}`;
    const w = new Walk(page);
    await startCompany(w, `Timed ${t.kind} ${s}`, code);
    await addOutlets(w, [{ tile: t.tile, name: t.name }]);
    await bundles(w, USUAL);
    await defaults(
      w,
      [
        `Priya Nair, , ${t.manager}, ${t.name}`,
        `Arjun Das, , ${t.role}, ${t.name}`,
        `Kiran Patil, , Cook, ${t.name}`,
      ].join('\n'),
    );
    await checkAndGoLive(w);
    const result = {
      kind: t.kind,
      taps: w.taps,
      fields: w.fields,
      seconds: w.seconds,
      steps: w.steps,
    };
    appendFileSync(
      join(import.meta.dirname, '..', 'test-results', 'setup-timings.jsonl'),
      `${JSON.stringify(result)}\n`,
    );
    await test.info().attach('timing', { body: JSON.stringify(result, null, 2) });
    expect(w.taps).toBeLessThan(40);
  });
}
