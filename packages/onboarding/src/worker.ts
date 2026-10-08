import type { ClientBase } from 'pg';
import { loadCustomer, type LoadOptions, type LoadReport } from './apply';
import { createCustomer } from './create';
import { newCustomerFrom, type CreatePayload } from './customer-files';

export { newCustomerFrom } from './customer-files';
import { inviteSender, type InviteSender } from './invites';
import type { ImportReport, InviteProgress } from './report';
import { checkDishPhotos, readUpload, UploadError } from './upload';
import { photosFromStore, photoStore, uploadStore, type UploadStore } from './upload-store';

// The platform worker (ADR 012, 013): claims queued platform jobs and runs them. It
// connects as platform_loader, which can write customer data but has no DDL rights and
// owns nothing; the web app never holds that credential.
//   create_customer   the loader on a new customer's minimal bundle
//   import_dry_run    the loader on an upload, rolled back: the report
//   import_apply      the same upload, committed (the console asks only after a dry run)
//   invite_logins     Cognito invitations within the pool's daily email allowance; the
//                     rest wait in the queue until the allowance frees up

export interface PlatformJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface WorkerOptions extends LoadOptions {
  store?: UploadStore;
  invites?: InviteSender;
}

type Outcome = {
  tenant?: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  /** invite_logins: back in the queue until then, instead of finishing */
  deferUntil?: Date;
};

/** Claims one due job and runs it; returns its id, or null when nothing is due. */
export async function runNextJob(
  client: ClientBase,
  opts: WorkerOptions = {},
): Promise<string | null> {
  const { rows } = await client.query<PlatformJob & { tenant_id: string | null }>(
    'select id, kind, tenant_id, payload from platform.claim_job()',
  );
  const job = rows[0];
  if (!job) return null;
  let out: Outcome;
  try {
    switch (job.kind) {
      case 'create_customer':
        out = await runCreate(client, job, opts);
        break;
      case 'import_dry_run':
      case 'import_apply':
        out = await runImport(client, job, opts);
        break;
      case 'invite_logins':
        out = await runInvites(client, job, opts);
        break;
      default:
        throw new Error(`unknown job kind ${job.kind}`);
    }
  } catch (err) {
    out = { result: null, error: (err as Error).message };
  }
  if (out.deferUntil) {
    await client.query('select platform.defer_job($1, $2, $3)', [
      job.id,
      out.deferUntil,
      out.result,
    ]);
  } else {
    await client.query('select platform.finish_job($1, $2, $3, $4)', [
      job.id,
      out.tenant ?? null,
      out.result,
      out.error,
    ]);
  }
  return job.id;
}

async function runCreate(
  client: ClientBase,
  job: PlatformJob,
  opts: LoadOptions,
): Promise<Outcome> {
  const created = await createCustomer(
    client,
    newCustomerFrom(job.payload as unknown as CreatePayload),
    opts,
  );
  if (!created.report.ok) {
    return {
      result: null,
      error: created.report.issues
        .map((i) => `${i.file}${i.row ? `:${i.row}` : ''} ${i.message}`)
        .join('; '),
    };
  }
  const tenant = created.tenantId ?? null;
  const owner = await client.query<{ id: string; email: string | null; login_type: string }>(
    `select id, email, login_type from core.app_user where tenant_id = $1 and username = $2`,
    [tenant, created.ownerUsername],
  );
  return {
    tenant,
    error: null,
    result: {
      owner_user_id: owner.rows[0]!.id,
      owner_username: created.ownerUsername,
      owner_email: owner.rows[0]!.email,
      owner_login_type: owner.rows[0]!.login_type,
      counts: created.report.counts,
    },
  };
}

export function importReport(report: LoadReport, files: string[]): ImportReport {
  let changes = 0;
  for (const n of Object.values(report.counts)) changes += n.created + n.updated;
  return {
    ok: report.ok,
    applied: report.applied,
    changes: report.ok ? changes : 0,
    counts: report.counts,
    issues: report.issues,
    warnings: report.warnings,
    files,
  };
}

const problems = (n: number) => `${n} problem${n === 1 ? '' : 's'} found; nothing was changed`;

async function runImport(
  client: ClientBase,
  job: PlatformJob & { tenant_id: string | null },
  opts: WorkerOptions,
): Promise<Outcome> {
  const key = typeof job.payload.key === 'string' ? job.payload.key : '';
  const tenant = await client.query<{ code: string }>(
    'select code from core.tenant where id = $1',
    [job.tenant_id],
  );
  const code = tenant.rows[0]?.code;
  if (!code) return { result: null, error: 'the customer does not exist' };
  const stored = await (opts.store ?? uploadStore()).get(key);
  let files: Record<string, string>;
  let customerCode: string;
  const photos = photosFromStore(stored.photos);
  try {
    // the same checks as at upload: only the onboarding files, and file 00 names this customer
    ({ files, customerCode } = readUpload(
      Object.entries(stored.files).map(([name, content]) => ({
        name,
        bytes: new TextEncoder().encode(content),
      })),
    ));
    checkDishPhotos(photos);
  } catch (err) {
    if (err instanceof UploadError) return { result: null, error: err.code };
    throw err;
  }
  if (customerCode !== code) {
    return {
      result: null,
      error: `CUSTOMER_MISMATCH: file 00 names ${customerCode || '(nothing)'}, not ${code}`,
    };
  }
  const report = await loadCustomer(client, files, {
    ...opts,
    dryRun: job.kind === 'import_dry_run',
    photos,
    putPhoto: opts.putPhoto ?? photoStore(),
  });
  const result = importReport(report, Object.keys(files));
  return {
    tenant: job.tenant_id,
    result: result as unknown as Record<string, unknown>,
    error: report.ok ? null : problems(report.issues.length),
  };
}

async function runInvites(
  client: ClientBase,
  job: PlatformJob & { tenant_id: string | null },
  opts: WorkerOptions,
): Promise<Outcome> {
  const sender = opts.invites ?? inviteSender();
  const allowance = async () =>
    (
      await client.query<{ remaining: number; next_free_at: Date | null }>(
        'select * from platform.invite_allowance()',
      )
    ).rows[0]!;
  const waiting = await client.query<{ id: string; username: string; email: string }>(
    `select id, username, email from core.app_user
      where tenant_id = $1 and kind = 'human' and status = 'active' and login_type = 'email'
        and cognito_sub is null and email is not null
      order by username`,
    [job.tenant_id],
  );
  const { remaining } = await allowance();
  const batch = waiting.rows.slice(0, remaining);
  let sent = 0;
  for (const person of batch) {
    const login = await sender.invite({ username: person.username, email: person.email });
    await client.query('select platform.record_invite($1, $2, $3)', [job.id, person.id, login.sub]);
    sent++;
  }
  const progress: InviteProgress = { sent, waiting: waiting.rows.length - sent };
  if (progress.waiting > 0) {
    const { next_free_at } = await allowance();
    return {
      tenant: job.tenant_id,
      result: { ...progress },
      error: null,
      deferUntil: next_free_at ?? new Date(Date.now() + 60_000),
    };
  }
  return { tenant: job.tenant_id, result: { ...progress }, error: null };
}
