import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { DEV_USERS } from '@outlet-ops/db/dev-users';
import { HANDLERS, runOnce } from '@outlet-ops/workflow';
import { newSession, SESSION_COOKIE, signSession } from '../lib/auth/session';

// The production suite runs against the standalone server, where /dev-login is compiled
// out (ADR 004). Sign-in is a session cookie signed with the server's SESSION_SECRET
// (what the Cognito callback issues). Requests come from the real inventory screens; the
// executor step is the real one (runOnce with the real handlers, as wf_executor).

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

/** Seeded delivery node ids (packages/db/seed/001_core.sql). */
export const NODE = {
  hub: '01920000-0000-7000-8000-000000000202',
  outletA: '01920000-0000-7000-8000-000000000203',
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

/** Kim's flow: a new order for one item at Outlet A. Returns the PO id. */
export async function createOrder(page: Page, item: string, qty: string): Promise<string> {
  await page.goto(`/stock/orders/new?node=${NODE.outletA}`);
  for (const input of await page.getByRole('textbox', { name: /^Quantity / }).all()) {
    await input.fill(''); // start from an empty order, not the suggestion
  }
  await page.getByRole('textbox', { name: `Quantity ${item}` }).fill(qty);
  await page.getByRole('button', { name: /^Submit order/ }).click();
  await page.waitForURL(/\/stock\/orders\/[0-9a-f-]{36}/);
  return new URL(page.url()).pathname.split('/').pop()!;
}
