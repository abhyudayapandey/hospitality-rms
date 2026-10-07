'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import {
  isBillFileType,
  MAX_BILL_BYTES,
  photosEnabled,
  presignComplianceUpload,
  type UploadTarget,
} from '@/lib/photos';

// Licences and the compliance calendar (ADR 069). Each write is one ops.* SECURITY DEFINER
// function, which decides access in SQL (COMPLIANCE, or the reminder's To do item; rule 2).

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, fn);
    revalidatePath('/compliance', 'layout');
    revalidatePath('/tasks', 'layout');
    revalidatePath('/');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

/** A presigned POST for one document at `node`'s outlet (a photo or a PDF, 10 MB at most). */
export async function getComplianceUploadUrl(
  node: string,
  contentType: string,
  size: number,
): Promise<ActionResult<UploadTarget>> {
  if (!photosEnabled()) {
    return { ok: false, code: 'INVALID_FILE', message: 'Uploads are off here.' };
  }
  if (!isBillFileType(contentType) || size < 1 || size > MAX_BILL_BYTES) {
    return failure(new Error('INVALID_FILE'));
  }
  const user = await requireUser();
  try {
    const where = await withUser(user.id, async (tx) => {
      const r = await sql<{ outlet: string; tenant: string }>`
        select ops.compliance_upload_place(${node}::uuid) as outlet,
               core.my_tenant() as tenant`.execute(tx);
      return r.rows[0]!;
    });
    return {
      ok: true,
      data: await presignComplianceUpload(where.tenant, where.outlet, contentType),
    };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('presign compliance upload failed', err);
    return f;
  }
}

export interface LicenceInput {
  id: string | null;
  node: string;
  kind: string;
  name: string;
  number: string;
  authority: string;
  issued_on: string | null;
  expires_on: string | null;
  renewal_role: string;
  files: string[];
}

export async function saveLicence(
  input: LicenceInput,
  idempotencyKey?: string,
): Promise<ActionResult<{ id: string }>> {
  return run('save_licence', async (tx) => {
    const r = await sql<{ id: string }>`
      select ops.save_licence(${input.id}::uuid, ${input.node}::uuid, ${input.kind},
                              ${input.name}, ${input.number}, ${input.authority},
                              ${input.issued_on}::date, ${input.expires_on}::date,
                              ${input.renewal_role}, ${input.files}::text[],
                              ${idempotencyKey ?? null}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function renewLicence(input: {
  id: string;
  number: string;
  issued_on: string | null;
  expires_on: string;
  files: string[];
}): Promise<ActionResult<{ id: string }>> {
  return run('renew_licence', async (tx) => {
    const r = await sql<{ id: string }>`
      select ops.renew_licence(${input.id}::uuid, ${input.number}, ${input.issued_on}::date,
                               ${input.expires_on}::date, ${input.files}::text[]) as id`.execute(
      tx,
    );
    return { id: r.rows[0]!.id };
  });
}

export async function archiveLicence(id: string, reason: string): Promise<ActionResult<null>> {
  return run('archive_licence', async (tx) => {
    await sql`select ops.archive_licence(${id}::uuid, ${reason})`.execute(tx);
    return null;
  });
}

export interface JobInput {
  id: string | null;
  node: string;
  name: string;
  every_months: number;
  next_due: string;
  owner_role: string;
  needs_proof: boolean;
}

export async function saveJob(
  input: JobInput,
  idempotencyKey?: string,
): Promise<ActionResult<{ id: string }>> {
  return run('save_compliance_item', async (tx) => {
    const r = await sql<{ id: string }>`
      select ops.save_compliance_item(${input.id}::uuid, ${input.node}::uuid, ${input.name},
                                      ${input.every_months}, ${input.next_due}::date,
                                      ${input.owner_role}, ${input.needs_proof},
                                      ${idempotencyKey ?? null}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function markJobDone(input: {
  id: string;
  done_on: string;
  files: string[];
  note: string;
}): Promise<ActionResult<{ next_due: string }>> {
  return run('mark_compliance_done', async (tx) => {
    const r = await sql<{ next_due: string }>`
      select ops.mark_compliance_done(${input.id}::uuid, ${input.done_on}::date,
                                      ${input.files}::text[], ${input.note})::text
               as next_due`.execute(tx);
    return { next_due: r.rows[0]!.next_due };
  });
}

export async function archiveJob(id: string): Promise<ActionResult<null>> {
  return run('archive_compliance_item', async (tx) => {
    await sql`select ops.archive_compliance_item(${id}::uuid)`.execute(tx);
    return null;
  });
}
