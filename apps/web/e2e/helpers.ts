import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { DEV_USERS } from '@outlet-ops/db/dev-users';
import { newSession, SESSION_COOKIE, signSession } from '../lib/auth/session';

// The production suite runs against the standalone server, where /dev-login and the
// test request form are compiled out (ADR 004). Sign-in is a session cookie signed with
// the server's SESSION_SECRET (what the Cognito callback issues), and requests are
// submitted through wf.submit as that user, exactly as the app's server code does.

function userId(name: string): string {
  const u = DEV_USERS.find((x) => x.name === name);
  if (!u) throw new Error(`unknown seeded user ${name}`);
  return u.id;
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
export async function signInAs(page: Page, name: string): Promise<void> {
  const token = await signSession(newSession(userId(name), 'cognito'), env('SESSION_SECRET'));
  const context = page.context();
  await context.clearCookies();
  await context.addCookies([
    { name: SESSION_COOKIE, value: token, url: baseUrl(), httpOnly: true, sameSite: 'Lax' },
  ]);
  await page.goto('/');
  await expect(page.getByTestId('current-user')).toHaveText(name);
}

/**
 * Submits a test workflow request as `name` via wf.submit inside the same transaction
 * shape as withUser (app_rw, app.user_id set locally). Payload {test: true} so the
 * global teardown removes it. Returns the request id.
 */
export async function submitTestRequest(
  name: string,
  processType: string,
  amount: number,
  nodeName = 'Outlet A',
): Promise<string> {
  const client = new pg.Client({ connectionString: env('DATABASE_URL') });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.user_id', $1, true)`, [userId(name)]);
    const proc = await client.query<{ subject_type: string; hierarchy_type: 'org' | 'delivery' }>(
      `select subject_type, hierarchy_type from wf.my_processes() where process_type = $1`,
      [processType],
    );
    const p = proc.rows[0];
    if (!p) throw new Error(`${name} cannot initiate ${processType}`);
    const node = await client.query<{ id: string }>(
      `select id from core.nodes() where name = $1 and type = $2 and not derived`,
      [nodeName, p.hierarchy_type],
    );
    const nodeId = node.rows[0]?.id;
    if (!nodeId) throw new Error(`${name} has no ${p.hierarchy_type} node ${nodeName}`);
    const r = await client.query<{ id: string }>(
      `select wf.submit($1, $2, core.uuid_v7(), '{"test": true}'::jsonb, $3, 'INR', $4::uuid, $5::uuid, null) as id`,
      [
        processType,
        p.subject_type,
        amount,
        p.hierarchy_type === 'org' ? nodeId : null,
        p.hierarchy_type === 'delivery' ? nodeId : null,
      ],
    );
    await client.query('commit');
    return r.rows[0]!.id;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
