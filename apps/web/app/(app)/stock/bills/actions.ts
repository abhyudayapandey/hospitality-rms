'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import {
  isBillFileType,
  MAX_BILL_BYTES,
  photosEnabled,
  presignBillUpload,
  type UploadTarget,
} from '@/lib/photos';

// Vendor bills (BIL-1 to BIL-3, ADR 050). Each write is one inv.* SECURITY DEFINER function,
// which decides access with core.can() (rule 2); the idempotency key comes from the form.

/**
 * A presigned POST for one bill file. inv.bill_place() decides who may add a bill and at
 * which store: the order's store for a bill for goods (`po`), else `node`. The key embeds
 * the tenant and that store, and inv.add_bill accepts only keys under it.
 */
export async function getBillUploadUrl(
  node: string | null,
  po: string | null,
  contentType: string,
  size: number,
): Promise<ActionResult<UploadTarget>> {
  if (!photosEnabled()) return { ok: false, code: 'INVALID_FILE', message: 'Uploads are off.' };
  if (!isBillFileType(contentType) || size < 1 || size > MAX_BILL_BYTES) {
    return failure(new Error('INVALID_FILE'));
  }
  const user = await requireUser();
  try {
    const where = await withUser(user.id, async (tx) => {
      const r = await sql<{ node: string; tenant: string }>`
        select inv.bill_place(${node}::uuid, ${po}::uuid) as node,
               core.my_tenant() as tenant`.execute(tx);
      return r.rows[0]!;
    });
    return { ok: true, data: await presignBillUpload(where.tenant, where.node, contentType) };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('presign bill upload failed', err);
    return f;
  }
}

export interface BillInput {
  node: string | null;
  po: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  bill_no: string | null;
  bill_date: string;
  amount: number;
  description: string | null;
  files: string[];
}

export async function addBill(
  input: BillInput,
  idempotencyKey: string,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  try {
    const id = await withUser(user.id, async (tx) => {
      const r = await sql<{ id: string }>`
        select inv.add_bill(${input.node}::uuid, ${input.po}::uuid, ${input.supplier_id}::uuid,
                            ${input.supplier_name}, ${input.bill_no}, ${input.bill_date}::date,
                            ${input.amount}, ${input.description}, ${input.files}::text[],
                            ${idempotencyKey}) as id`.execute(tx);
      return r.rows[0]!.id;
    });
    revalidatePath('/stock', 'layout');
    return { ok: true, data: { id } };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('add_bill failed', err);
    return f;
  }
}

export async function archiveBill(bill: string, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await withUser(user.id, async (tx) => {
      await sql`select inv.archive_bill(${bill}::uuid, ${reason})`.execute(tx);
    });
    revalidatePath('/stock', 'layout');
    return { ok: true, data: undefined };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('archive_bill failed', err);
    return f;
  }
}
