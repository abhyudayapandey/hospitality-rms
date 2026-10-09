'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { loginDirectory } from '@/lib/auth/directory';
import { generateTemporaryPassword, testRulePassword } from '@/lib/auth/passwords';
import { sql, withPlatformAdmin, type Tx } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/platform/server';
import { requireSameOrigin } from '@/lib/security/same-origin';

// Platform console actions (ADR 012). Every one checks the origin and the platform session,
// then calls one platform.* function, which checks the admin again and writes the platform
// audit. No customer data is readable in these requests.

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireSameOrigin();
    const admin = await requirePlatformAdmin();
    const data = await withPlatformAdmin(admin, fn);
    revalidatePath('/platform', 'layout');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, (err as Error).name);
    return f;
  }
}

export async function setCustomerStatus(
  tenantId: string,
  status: 'suspended' | 'active',
  reason: string,
): Promise<ActionResult<string>> {
  return run('set_status', async (tx) => {
    const r =
      status === 'suspended'
        ? await sql<{
            s: string;
          }>`select platform.suspend(${tenantId}::uuid, ${reason}) as s`.execute(tx)
        : await sql<{ s: string }>`
            select platform.reactivate(${tenantId}::uuid, ${reason}) as s`.execute(tx);
    return r.rows[0]!.s;
  });
}

export interface NewCustomerForm {
  code: string;
  name: string;
  country: string;
  currency: string;
  timezone: string;
  isTest: boolean;
  ownerName: string;
  /** 'email': invitation by email; 'username': no email, login made on the Logins page. */
  ownerLoginType: 'email' | 'username';
  /** Optional; defaults to <code>.owner. Match file 07 when the customer's import has one. */
  ownerUsername: string;
  ownerEmail: string;
}

export async function requestCustomer(f: NewCustomerForm): Promise<ActionResult<string>> {
  return run('request_create_customer', async (tx) => {
    const payload = {
      code: f.code,
      name: f.name,
      country: f.country,
      currency: f.currency,
      timezone: f.timezone,
      is_test: f.isTest,
      owner: {
        display_name: f.ownerName,
        login_type: f.ownerLoginType,
        username: f.ownerUsername.trim() || null,
        email: f.ownerLoginType === 'email' ? f.ownerEmail : null,
      },
    };
    const r = await sql<{ id: string }>`
      select platform.request_create_customer(${JSON.stringify(payload)}::jsonb) as id`.execute(tx);
    return r.rows[0]!.id;
  });
}

/**
 * After the worker created the customer: creates the owner's Cognito login with an email
 * invitation (they set their own password) and records it. Safe to retry.
 */
export async function inviteOwner(jobId: string): Promise<ActionResult<string>> {
  const job = await run('job', async (tx) => {
    const r = await sql<{
      status: string;
      result: { owner_username: string; owner_email: string | null } | null;
    }>`
      select status, result from platform.jobs(200) where id = ${jobId}::uuid`.execute(tx);
    return r.rows[0];
  });
  if (!job.ok) return job;
  // a username owner gets no email: their login is made on the customer's Logins page
  if (!job.data || job.data.status !== 'done' || !job.data.result?.owner_email) {
    return failure(new Error('INVALID_STATE'));
  }
  const { owner_username: username } = job.data.result;
  const email = job.data.result.owner_email;
  let sub: string;
  try {
    ({ sub } = await loginDirectory().create({
      username,
      loginType: 'email',
      email,
      invite: true,
    }));
  } catch (err) {
    console.error('owner invite failed', (err as Error).name);
    return failure(new Error('UNEXPECTED'));
  }
  const linked = await run('link_owner_login', (tx) =>
    sql`select platform.link_owner_login(${jobId}::uuid, ${sub})`.execute(tx),
  );
  if (!linked.ok) return linked;
  return { ok: true, data: email };
}

/** Apply an import after its dry run (ADR 013): a new job; the worker loads the same upload. */
export async function applyImport(dryRunJobId: string): Promise<ActionResult<string>> {
  return run('request_import_apply', async (tx) => {
    const r = await sql<{ id: string }>`
      select platform.request_import_apply(${dryRunJobId}::uuid) as id`.execute(tx);
    return r.rows[0]!.id;
  });
}

export interface CreatedLogin {
  username: string;
  displayName: string;
  /** Shown once and offered as a download once; never stored or logged. */
  password: string;
  /** Test<Role>!12 passwords are kept; generated ones are changed at the first sign-in. */
  permanent: boolean;
}

export interface LoginBatch {
  created: CreatedLogin[];
  /** People skipped, with why (no job title for the Test<Role>!12 rule). */
  skipped: { username: string; reason: string }[];
  /** Set when a login failed part-way; the ones before it are created and shown. */
  error: string | null;
}

/**
 * Username logins for a customer's imported people (ADR 013). The database says who needs
 * one and refuses the Test<Role>!12 option for customers that are not test customers; each
 * login is created in Cognito, then linked (and audited, without the password).
 */
export async function createUsernameLogins(
  tenantId: string,
  testRule: boolean,
): Promise<ActionResult<LoginBatch>> {
  const people = await run('begin_logins', async (tx) => {
    const r = await sql<{
      user_id: string;
      username: string;
      display_name: string;
      job_title: string | null;
    }>`select * from platform.begin_logins(${tenantId}::uuid, ${testRule})`.execute(tx);
    return r.rows;
  });
  if (!people.ok) return people;
  const batch: LoginBatch = { created: [], skipped: [], error: null };
  const directory = loginDirectory();
  for (const p of people.data) {
    if (testRule && !p.job_title) {
      batch.skipped.push({
        username: p.username,
        reason: 'no job title for the Test<Role>!12 rule',
      });
      continue;
    }
    const password = testRule ? testRulePassword(p.job_title!) : generateTemporaryPassword();
    try {
      const { sub } = await directory.create({
        username: p.username,
        loginType: 'username',
        temporaryPassword: password,
      });
      if (testRule) await directory.setPermanentPassword(p.username, password);
      const linked = await run('link_customer_login', (tx) =>
        sql`select platform.link_customer_login(${p.user_id}::uuid, ${sub})`.execute(tx),
      );
      if (!linked.ok) {
        batch.error = `${p.username}: ${linked.message}`;
        break;
      }
    } catch (err) {
      console.error('login creation failed', (err as Error).name);
      batch.error = `${p.username}: ${failure(new Error('UNEXPECTED')).message}`;
      break;
    }
    batch.created.push({
      username: p.username,
      displayName: p.display_name,
      password,
      permanent: testRule,
    });
  }
  return { ok: true, data: batch };
}

/** Queues the email invitations; the worker sends them within the daily allowance. */
export async function requestInvites(tenantId: string): Promise<ActionResult<string | null>> {
  return run('request_invites', async (tx) => {
    const r = await sql<{ id: string | null }>`
      select platform.request_invites(${tenantId}::uuid) as id`.execute(tx);
    return r.rows[0]!.id;
  });
}

export interface RemovedOwner {
  mode: 'deleted' | 'deactivated';
  username: string;
  /** Set when a Cognito login existed: it has been disabled and signed out everywhere. */
  login: string | null;
}

/**
 * Removes an extra account owner (ADR 013): deleted if they never signed in and nothing
 * refers to them, otherwise deactivated with ACCOUNT_OWNER revoked. The database checks
 * the platform admin, the reason and that another owner remains, and writes the audit;
 * then an existing Cognito login is disabled and signed out everywhere.
 */
export async function removeAccountOwner(
  tenantId: string,
  userId: string,
  reason: string,
): Promise<ActionResult<RemovedOwner>> {
  const r = await run('remove_account_owner', async (tx) => {
    const x = await sql<{ r: RemovedOwner }>`
      select platform.remove_account_owner(${tenantId}::uuid, ${userId}::uuid, ${reason}) as r`.execute(
      tx,
    );
    return x.rows[0]!.r;
  });
  if (!r.ok || !r.data.login) return r;
  try {
    const directory = loginDirectory();
    await directory.disable(r.data.login);
    await directory.signOutEverywhere(r.data.login);
  } catch (err) {
    console.error('owner login disable failed', (err as Error).name);
    return failure(new Error('UNEXPECTED'));
  }
  return r;
}

/**
 * Puts a bundle in or out of a customer's plan (ADR 067). platform.set_bundle checks the
 * admin again and writes the platform audit; true when something changed.
 */
export async function setBundle(
  tenantId: string,
  bundle: string,
  on: boolean,
): Promise<ActionResult<boolean>> {
  return run('set_bundle', async (tx) => {
    const r = await sql<{ changed: boolean }>`
      select platform.set_bundle(${tenantId}::uuid, ${bundle}, ${on}) as changed`.execute(tx);
    return r.rows[0]!.changed;
  });
}

/**
 * One block of a customer on or off (ADR 085): only platform admins, only inside a bundle in
 * its plan (NOT_IN_PLAN), in the platform audit. Nobody in the customer can.
 */
export async function setModule(
  tenantId: string,
  code: string,
  on: boolean,
): Promise<ActionResult<boolean>> {
  return run('set_module', async (tx) => {
    const r = await sql<{ changed: boolean }>`
      select platform.set_module(${tenantId}::uuid, ${code}, ${on}) as changed`.execute(tx);
    return r.rows[0]!.changed;
  });
}
