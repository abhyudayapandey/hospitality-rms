import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { HANDLERS, runOnce } from '@outlet-ops/workflow';
import { execFileSync } from 'node:child_process';
import { newSession, SESSION_COOKIE, signSession } from '../lib/auth/session';
import { newPlatformSession, PLATFORM_COOKIE, signPlatformSession } from '../lib/platform/session';

// The production suite runs against the standalone server, where /dev-login is compiled
// out (ADR 004). Sign-in is a session cookie signed with the server's SESSION_SECRET
// (what the Cognito callback issues). Requests come from the real inventory screens; the
// executor step is the real one (runOnce with the real handlers, as wf_executor). People
// and places are the test customers' (docs/onboarding/test-data, loaded by pnpm db:seed),
// looked up by display name and code as the migrator, like the seed.

/** Runs one query as the migrator (lookups and test setup only). */
export async function asMigrator<T extends object>(text: string, params: unknown[]): Promise<T[]> {
  const client = new pg.Client({ connectionString: env('MIGRATOR_DATABASE_URL') });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

const ids = new Map<string, string>();

/** The id of a test user by display name (unique across the test customers). */
async function userId(name: string): Promise<string> {
  const key = `user:${name}`;
  if (!ids.has(key)) {
    const rows = await asMigrator<{ id: string }>(
      `select id from core.app_user where display_name = $1 and kind = 'human'`,
      [name],
    );
    if (rows.length !== 1) throw new Error(`test user ${name}: ${rows.length} found`);
    ids.set(key, rows[0]!.id);
  }
  return ids.get(key)!;
}

/** The id of a test place by code, e.g. TEST-BAR-3.0-KITCHEN-STORE. */
export async function placeId(code: string): Promise<string> {
  const key = `place:${code}`;
  if (!ids.has(key)) {
    const rows = await asMigrator<{ id: string }>(
      `select id from core.hierarchy_node where code = $1`,
      [code],
    );
    if (rows.length !== 1) throw new Error(`test place ${code}: ${rows.length} found`);
    ids.set(key, rows[0]!.id);
  }
  return ids.get(key)!;
}

export function baseUrl(): string {
  return `http://127.0.0.1:${process.env.E2E_PORT ?? 3100}`;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Signs in as a seeded user (replacing any current session) and opens the home page. */
// The simpler screens keep detail behind a tap: "More figures", "Show the numbers", "Show N
// more" (ADR 047). Most specs are about what is in the detail, so by default a page opens it as
// soon as it appears; the specs about the closed state pass { expanded: false }.
const EXPAND_SCRIPT = `(() => {
  const SEL = [
    'details[data-testid="more-figures"]', 'details[data-testid="cost-numbers"]',
    'details[data-testid="stock-more"]', 'details[data-testid="shifts-later"]',
    'details[data-testid="role-details"]', '[data-testid="attention-card"] details',
  ].join(',');
  setInterval(() => {
    document.querySelectorAll(SEL).forEach((d) => { if (!d.open) d.open = true; });
    document.querySelectorAll('[data-testid="show-more"]').forEach((b) => b.click());
  }, 150);
})();`;

export async function signInAs(
  page: Page,
  name: string,
  options: { expanded?: boolean } = {},
): Promise<void> {
  if (options.expanded ?? true) await page.context().addInitScript(EXPAND_SCRIPT);
  const token = await signSession(newSession(await userId(name), 'cognito'), env('SESSION_SECRET'));
  const context = page.context();
  // Leave the current page first: an in-flight prefetch or poll from it could otherwise
  // answer after the swap with Set-Cookie for the previous (or no) session.
  await page.goto('about:blank');
  await context.clearCookies();
  await context.addCookies([
    { name: SESSION_COOKIE, value: token, url: baseUrl(), httpOnly: true, sameSite: 'Lax' },
  ]);
  await page.goto('/');
  await expect(page.getByTestId('current-user')).toHaveText(name);
}

/**
 * Signs in to the platform console as the e2e platform admin (a platform.admin row, as the
 * platform pool's sign-in would create for a member of platform-admins). Replaces any
 * customer session: the two never mix.
 */
export async function signInPlatform(page: Page): Promise<void> {
  const [admin] = await asMigrator<{ id: string }>(
    `insert into platform.admin (cognito_sub, email) values ('e2e-platform-admin', 'ops@example.test')
     on conflict (cognito_sub) do update set status = 'active' returning id`,
    [],
  );
  const token = await signPlatformSession(newPlatformSession(admin!.id), env('SESSION_SECRET'));
  await page.goto('about:blank');
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: PLATFORM_COOKIE,
      value: token,
      domain: new URL(baseUrl()).hostname,
      path: '/platform',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

/** Runs the platform worker until the queue is empty, exactly as the service does. */
export function runPlatformWorker(): void {
  execFileSync('pnpm', ['--filter', '@outlet-ops/onboarding', 'worker', '--once'], {
    cwd: new URL('../../..', import.meta.url).pathname,
    env: { ...process.env, PLATFORM_LOADER_DATABASE_URL: env('PLATFORM_LOADER_DATABASE_URL') },
    stdio: 'pipe',
  });
}

/**
 * The places the flows use: Test Bar 3.0's Kitchen Store (kept by the head cook, under the
 * Bar Manager), supplied by the central kitchen store; its Floor Service team (the server
 * and the host) is rostered by the Bar Manager.
 */
export const PLACE = {
  store: 'TEST-BAR-3.0-KITCHEN-STORE',
  centralKitchen: 'TEST-CENTRAL-KITCHEN-STORE',
  floor: 'TEST-BAR-3.0-FLOOR-SERVICE',
} as const;

/** Runs the workflow executor once, exactly as the wf-execute timer does. */
export async function runExecutor(): Promise<void> {
  const pool = new pg.Pool({ connectionString: env('WF_EXECUTOR_DATABASE_URL') });
  try {
    await runOnce(pool, HANDLERS);
  } finally {
    await pool.end();
  }
}

/** The head cook's flow: a new order for one item at the Kitchen Store. Returns the PO id. */
export async function createOrder(page: Page, item: string, qty: string): Promise<string> {
  await page.goto(`/stock/orders/new?node=${await placeId(PLACE.store)}`);
  for (const input of await page.getByRole('textbox', { name: /^Quantity / }).all()) {
    await input.fill(''); // start from an empty order, not the suggestion
  }
  await page.getByRole('textbox', { name: `Quantity ${item}` }).fill(qty);
  await page.getByRole('button', { name: /^Send request/ }).click();
  await page.waitForURL(/\/stock\/orders\/[0-9a-f-]{36}/);
  return new URL(page.url()).pathname.split('/').pop()!;
}

/**
 * Test setup for the people flows: clears workforce activity in one far-future week in
 * Floor Service (shifts, assignments, swaps, leave) so the spec can re-run on the same local
 * database, and makes sure the swap colleague exists: a second server there, since the test
 * data has one person per role (a fixture, like the DB tests'). Runs as migrator, like the
 * seed; CI starts from a fresh database anyway.
 */
export async function setupPeopleWeek(monday: string): Promise<void> {
  const floor = await placeId(PLACE.floor);
  const client = new pg.Client({ connectionString: env('MIGRATOR_DATABASE_URL') });
  await client.connect();
  try {
    await client.query(
      `with t as (select id from core.tenant where code = 'TEST-COMPANY'),
       u as (insert into core.app_user (tenant_id, kind, display_name, username)
             select id, 'human', 'E2E Server 3.0', 'e2e.server.3.0' from t
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
    await client.query(
      `with s as (select id from hr.shift
                   where org_node_id = $1 and local_date between $2::date and $2::date + 6)
       , sw as (delete from hr.shift_swap where shift_id in (select id from s) returning 1)
       , ex as (delete from hr.attendance_exception where shift_id in (select id from s) returning 1)
       select (select count(*) from sw) + (select count(*) from ex)`,
      [floor, monday],
    );
    await client.query(
      `delete from hr.shift_assignment where shift_id in (
         select id from hr.shift where org_node_id = $1
            and local_date between $2::date and $2::date + 6)`,
      [floor, monday],
    );
    await client.query(
      `delete from hr.shift where org_node_id = $1 and local_date between $2::date and $2::date + 6`,
      [floor, monday],
    );
    await client.query(
      `delete from hr.leave_request where org_node_id = $1
          and from_date <= $2::date + 6 and to_date >= $2::date`,
      [floor, monday],
    );
    // the week's draft shifts from the templates: the screen adds only tomorrow to day 7
    // (ADR 024), and this week is four weeks out
    await client.query(
      `insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                             role_code, headcount)
       select t.tenant_id, t.org_node_id, t.id, d.day,
              (d.day + t.start_time) at time zone hr.node_tz($1),
              (d.day + case when t.end_time > t.start_time then 0 else 1 end + t.end_time)
                at time zone hr.node_tz($1),
              t.role_code, t.headcount
         from hr.shift_template t
        cross join lateral (select $2::date + i as day from generate_series(0, 6) i) d
        where t.org_node_id = $1 and t.archived_at is null
          and extract(isodow from d.day)::int = any (t.weekdays)`,
      [floor, monday],
    );
  } finally {
    await client.end();
  }
}

/**
 * A tap now shows the next screen's skeleton at once and its address before its content
 * (ADR 055): wait until the screen is in before reading it.
 */
export async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId('page-loading')).toHaveCount(0, { timeout: 30_000 });
}

/**
 * The place the "Place:" switcher shows (ADR 016), by its full name: the chosen option
 * when it is a picker (options show short names; data-name has the full one), the label
 * when there is only one place, '' when the screen shows none.
 */
export async function viewing(page: Page): Promise<string> {
  await settled(page);
  const bar = page.getByTestId('place-switcher');
  if ((await bar.count()) === 0) return '';
  const picker = bar.getByRole('combobox', { name: 'Place' });
  if ((await picker.count()) > 0) {
    return (await picker.locator('option:checked').getAttribute('data-name')) ?? '';
  }
  // no waiting here: a screen mid-change may have neither yet, and callers poll
  const label = bar.getByTestId('viewing');
  if ((await label.count()) === 0) return '';
  return (await label.textContent())?.trim() ?? '';
}

/** The full names of the "Place:" picker's options ([] when it is a plain label or absent). */
export async function viewingOptions(page: Page): Promise<string[]> {
  await settled(page);
  const picker = page.getByTestId('place-switcher').getByRole('combobox', { name: 'Place' });
  if ((await picker.count()) === 0) return [];
  return picker
    .locator('option')
    .evaluateAll((os) => os.map((o) => o.getAttribute('data-name') ?? ''));
}

/**
 * A late template at Floor Service, for the template-shifts test (ADR 024): the test data's
 * shifts there are published, so nothing would be left to add. `on` (re)creates it with no
 * shifts; off archives it and cancels its shifts.
 */
export async function lateTemplate(on: boolean): Promise<void> {
  const floor = await placeId(PLACE.floor);
  const client = new pg.Client({ connectionString: env('MIGRATOR_DATABASE_URL') });
  await client.connect();
  try {
    await client.query(
      `with t as (select id from hr.shift_template where org_node_id = $1 and name = 'E2E Late'),
       s as (update hr.shift set status = 'cancelled'
              where template_id in (select id from t) and status <> 'cancelled' returning id)
       update hr.shift_assignment set status = 'dropped', drop_reason = 'shift_cancelled'
        where shift_id in (select id from s) and status = 'assigned'`,
      [floor],
    );
    await client.query(
      `insert into hr.shift_template (tenant_id, org_node_id, name, role_code, start_time,
                                      end_time, headcount, weekdays, archived_at)
       select tenant_id, id, 'E2E Late', 'HOST', '22:00', '23:30', 1, '{1,2,3,4,5,6,7}',
              case when $2 then null else now() end
         from core.hierarchy_node where id = $1
       on conflict (tenant_id, org_node_id, name, role_code)
       do update set archived_at = excluded.archived_at`,
      [floor, on],
    );
  } finally {
    await client.end();
  }
}
