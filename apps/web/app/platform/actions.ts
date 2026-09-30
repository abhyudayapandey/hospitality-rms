'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { loginDirectory } from '@/lib/auth/directory';
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
      owner: { display_name: f.ownerName, email: f.ownerEmail },
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
      result: { owner_username: string; owner_email: string } | null;
    }>`
      select status, result from platform.jobs(200) where id = ${jobId}::uuid`.execute(tx);
    return r.rows[0];
  });
  if (!job.ok) return job;
  if (!job.data || job.data.status !== 'done' || !job.data.result) {
    return failure(new Error('INVALID_STATE'));
  }
  const { owner_username: username, owner_email: email } = job.data.result;
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
