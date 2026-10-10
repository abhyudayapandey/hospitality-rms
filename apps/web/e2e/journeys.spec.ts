import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { asMigrator, meTile, signInAs } from './helpers';

// How many taps the common jobs take, from Home (UX review U-27, ADR 026). Each journey
// starts on Home, walks to the job and stops at its last button, which it checks is ready
// and counts without pressing, so nothing is written. "To get there" is the taps from Home
// to the job's screen; "In the form" the choices and the last button; "Typed" the fields
// filled in. The test fails if a job takes more taps than its budget, so a later change
// can't quietly make one longer. The table goes to test-results/journeys.md.

interface Result {
  job: string;
  who: string;
  there: number;
  form: number;
  typed: number;
}
const results: Result[] = [];

class Journey {
  there = 0;
  form = 0;
  typed = 0;
  /** A tap that moves towards the job. */
  async go(l: Locator) {
    this.there++;
    await l.click();
  }
  /** A choice in the job's form. */
  async choose(l: Locator, option: { index: number }) {
    this.form++;
    await l.selectOption(option);
  }
  /** A tap on a choice in the job's form (a picture, a chip). */
  async tap(l: Locator) {
    this.form++;
    await l.click();
  }
  async type(l: Locator, text: string) {
    this.typed++;
    await l.fill(text);
  }
  /** The job's last button: ready, counted, not pressed. */
  async last(l: Locator) {
    this.form++;
    await expect(l).toBeEnabled();
  }
  done(job: string, who: string, budget: { there: number; form: number }) {
    results.push({
      job,
      who,
      there: this.there,
      form: this.form,
      typed: this.typed,
    });
    expect(this.there, `${job}: taps to get there`).toBeLessThanOrEqual(budget.there);
    expect(this.form, `${job}: taps in the form`).toBeLessThanOrEqual(budget.form);
  }
}

async function start(page: Page, who: string): Promise<Journey> {
  await signInAs(page, who); // lands on Home
  return new Journey();
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

test.afterAll(() => {
  const dir = join(import.meta.dirname, '..', 'test-results');
  mkdirSync(dir, { recursive: true });
  const lines = [
    '| Job | Who | Taps to get there | Taps in the form | Fields typed |',
    '| --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.job} | ${r.who} | ${r.there} | ${r.form} | ${r.typed} |`),
  ];
  writeFileSync(join(dir, 'journeys.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
});

test('clock in (server)', async ({ page }) => {
  const j = await start(page, 'Test Server 3.0');
  const card = page.getByTestId('shift-card').getByRole('link', { name: /Clock (in|out)/ });
  if (await card.isVisible()) {
    await j.go(card);
  } else {
    // off shift: Shifts & leave, then its Clock tab (ADR 113)
    await j.go(nav(page, 'Me'));
    await j.go(page.getByTestId('me-shifts'));
    await j.go(page.getByRole('navigation', { name: 'Me' }).getByRole('link', { name: 'Clock' }));
  }
  await j.last(page.getByRole('button', { name: /^Clock (in with a selfie|out)$/ }));
  j.done('Clock in', 'Server', { there: 3, form: 1 });
});

test('open my next task (commis)', async ({ page }) => {
  const j = await start(page, 'Test Commis 1.0');
  await j.go(page.getByTestId('tasks-card').getByRole('link').first());
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}/);
  await j.last(
    page
      .getByRole('button')
      .filter({ hasText: /^(Done|Save|Record the batch)$/ })
      .first(),
  );
  j.done('Open my next task', 'Commis', { there: 1, form: 1 });
});

test('report a problem (commis)', async ({ page }) => {
  const j = await start(page, 'Test Commis 1.0');
  await j.go(nav(page, 'Tasks'));
  await j.go(page.getByRole('link', { name: 'Report a problem' }));
  // a tap, not a sentence (ADR 113)
  await j.tap(
    page
      .getByRole('group', { name: 'What is wrong' })
      .getByRole('button', { name: 'AC or fridge' }),
  );
  await j.last(page.getByRole('button', { name: 'Send to maintenance' }));
  j.done('Report a problem', 'Commis', { there: 2, form: 2 });
});

test('record wastage (store keeper)', async ({ page }) => {
  const j = await start(page, 'Test Store Keeper 1.0');
  await j.go(nav(page, 'Stock'));
  // the store's jobs under its list (ADR 052); the Wastage tab is behind More (ADR 053, 054)
  await j.go(
    page
      .getByRole('navigation', { name: 'Stock jobs' })
      .getByRole('link', { name: 'Record wastage' }),
  );
  // nothing is chosen for them (ADR 113): a picture, how much, why
  await j.tap(page.getByTestId('item-choice').first());
  await j.type(page.getByLabel(/^Quantity/), '1');
  await j.tap(page.getByRole('group', { name: 'Reason' }).getByRole('button', { name: 'Spoiled' }));
  await j.last(page.getByRole('button', { name: 'Record wastage' }));
  j.done('Record wastage', 'Store keeper', { there: 2, form: 3 });
});

test('count a store (store keeper)', async ({ page }) => {
  const j = await start(page, 'Test Store Keeper 1.0');
  await j.go(nav(page, 'Stock'));
  await j.go(
    page.getByRole('navigation', { name: 'Stock tabs' }).getByRole('link', { name: 'Count' }),
  );
  await j.last(page.getByRole('button', { name: 'Start a count' }));
  j.done('Start a count', 'Store keeper', { there: 2, form: 1 });
});

test('approve leave (floor manager)', async ({ page }) => {
  // a leave request from the server, far enough out to touch no shift (once per database)
  await asMigrator(
    `with me as materialized (
       select set_config('app.user_id', u.id::text, true) as s
         from core.app_user u where u.username = 'test.server.3.0')
     select hr.request_leave(t.id, current_date + 150, current_date + 150, 'journeys')
       from me, hr.leave_type t join core.tenant te on te.id = t.tenant_id
      where te.code = 'TEST-COMPANY' and t.code = 'UNPAID_LEAVE'
        and not exists (select 1 from hr.leave_request l
                         where l.owner_user_id = (select id from core.app_user
                                                   where username = 'test.server.3.0')
                           and l.from_date = current_date + 150 and l.status <> 'cancelled')`,
    [],
  );
  const j = await start(page, 'Test Floor Manager 3.0');
  // what needs their yes is on Home (UX-6); otherwise Approvals is one tap away
  const onHome = page
    .getByTestId('approvals-card')
    .getByTestId('inbox-item')
    .filter({ hasText: 'Test Server 3.0' })
    .filter({ hasText: 'Leave' });
  if ((await onHome.count()) === 0) await j.go(page.getByRole('link', { name: /^To do list/ }));
  await j.go(
    page
      .getByTestId('inbox-item')
      .filter({ hasText: 'Test Server 3.0' })
      .filter({ hasText: 'Leave' })
      .getByRole('link', { name: 'Review' })
      .first(),
  );
  await j.last(page.getByRole('button', { name: 'Approve' }));
  j.done('Approve leave', 'Department head', { there: 2, form: 1 });
});

test('fill an open slot (executive chef)', async ({ page }) => {
  // Home's "Do these first" links to the first day with an open slot (U-27): before, this
  // took Roster → the day → Assign
  const j = await start(page, 'Test Executive Chef 1.0');
  await j.go(
    page.getByTestId('dofirst-card').getByRole('link', { name: /open shifts? in the next 7 days/ }),
  );
  await j.go(
    page
      .getByTestId('roster-day')
      .getByRole('link', { name: /^Assign/ })
      .first(),
  );
  await j.last(page.getByTestId('candidates').getByRole('button', { name: 'Assign' }).first());
  j.done('Fill an open slot', 'Department head', { there: 2, form: 1 });
});

test("today's sales (cost controller)", async ({ page }) => {
  const j = await start(page, 'Test Cost Controller 1.0');
  // before the day's sales are in, Home says so in a line instead of ₹0 (ADR 098)
  await expect(page.getByTestId('tile-sales').or(page.getByTestId('no-sales-yet'))).toBeVisible();
  j.done("See today's sales", 'Cost controller', { there: 0, form: 0 });
});

test('my week (server)', async ({ page }) => {
  const j = await start(page, 'Test Server 3.0');
  await j.go(nav(page, 'Me'));
  await j.go(await meTile(page, 'myWeek'));
  await expect(page.getByTestId('report-week')).toBeVisible();
  j.done('See my week', 'Server', { there: 2, form: 0 });
});
