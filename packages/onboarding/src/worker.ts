import type { ClientBase } from 'pg';
import type { LoadOptions } from './apply';
import { createCustomer, type NewCustomer } from './create';

// The platform worker (ADR 012): claims queued platform jobs and runs them. It connects
// as platform_loader, which can write customer data but has no DDL rights and owns
// nothing; the web app never holds that credential.

export interface PlatformJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

interface CreatePayload {
  code: string;
  name: string;
  country?: string;
  currency?: string;
  timezone?: string;
  is_test?: boolean;
  owner: { display_name: string; email: string };
}

export function newCustomerFrom(p: CreatePayload): NewCustomer {
  return {
    code: p.code,
    name: p.name.trim(),
    country: p.country?.trim() || 'India',
    currency: p.currency?.trim() || 'INR',
    timezone: p.timezone?.trim() || 'Asia/Kolkata',
    isTest: p.is_test === true,
    owner: { displayName: p.owner.display_name.trim(), email: p.owner.email },
  };
}

/** Claims one queued job and runs it; returns its id, or null when the queue is empty. */
export async function runNextJob(
  client: ClientBase,
  opts: LoadOptions = {},
): Promise<string | null> {
  const { rows } = await client.query<PlatformJob>(
    'select id, kind, payload from platform.claim_job()',
  );
  const job = rows[0];
  if (!job) return null;
  let tenant: string | null = null;
  let result: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    if (job.kind !== 'create_customer') throw new Error(`unknown job kind ${job.kind}`);
    const created = await createCustomer(
      client,
      newCustomerFrom(job.payload as unknown as CreatePayload),
      opts,
    );
    if (!created.report.ok) {
      error = created.report.issues
        .map((i) => `${i.file}${i.row ? `:${i.row}` : ''} ${i.message}`)
        .join('; ');
    } else {
      tenant = created.tenantId ?? null;
      const owner = await client.query<{ id: string; email: string }>(
        `select id, email from core.app_user where tenant_id = $1 and username = $2`,
        [tenant, created.ownerUsername],
      );
      result = {
        owner_user_id: owner.rows[0]!.id,
        owner_username: created.ownerUsername,
        owner_email: owner.rows[0]!.email,
        counts: created.report.counts,
      };
    }
  } catch (err) {
    error = (err as Error).message;
  }
  await client.query('select platform.finish_job($1, $2, $3, $4)', [job.id, tenant, result, error]);
  return job.id;
}
