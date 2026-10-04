'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import {
  isPhotoType,
  MAX_PHOTO_BYTES,
  photosEnabled,
  presignPhotoUpload,
  type UploadTarget,
} from '@/lib/photos';

// The stock check (INV-10, ADR 043). Each action calls one inv.* SECURITY DEFINER function,
// which checks core.can(STOCK_CHECK) at the store (rule 2) and changes stock only through
// ledger rows (rule 3). Counting is safe to repeat and to send late: record_check_line keeps
// the count with the latest original time.

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, fn);
    revalidatePath('/stock', 'layout');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

export async function startStockCheck(
  node: string,
  mode: 'standard' | 'bar',
  idempotencyKey: string,
): Promise<ActionResult<{ id: string }>> {
  return run('start_stock_check', async (tx) => {
    const r = await sql<{ id: string }>`
      select inv.start_stock_check(${node}::uuid, ${mode}, ${idempotencyKey}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export interface CheckLineInput {
  check: string;
  item: string;
  counted: number | null;
  photoKey?: string | null;
  area?: string | null;
  /** when it was counted: the device's time, kept when the count syncs later (INV-8) */
  countedAt?: string | null;
  device?: string | null;
  full?: number | null;
  tenths?: number | null;
}

export async function recordCheckLine(i: CheckLineInput): Promise<ActionResult<null>> {
  return run('record_check_line', async (tx) => {
    await sql`
      select inv.record_check_line(${i.check}::uuid, ${i.item}::uuid, ${i.counted}::numeric,
                                   ${i.photoKey ?? null}, ${i.area ?? null},
                                   ${i.countedAt ?? null}::timestamptz, ${i.device ?? null},
                                   ${i.full ?? null}::numeric, ${i.tenths ?? null}::integer)`.execute(
      tx,
    );
    return null;
  });
}

export interface ReviewLine {
  item_id: string;
  name: string;
  unit: string;
  area: string | null;
  expected_qty: string;
  counted_qty: string | null;
  difference: string;
  needs_photo: boolean;
  photo_key: string | null;
  uncounted: boolean;
}

export async function reviewStockCheck(check: string): Promise<ActionResult<ReviewLine[]>> {
  return run('review_stock_check', async (tx) => {
    const r = await sql<ReviewLine>`
      select item_id, name, unit, area, expected_qty, counted_qty, difference, needs_photo,
             photo_key, uncounted
        from inv.review_stock_check(${check}::uuid)`.execute(tx);
    return r.rows;
  });
}

export interface CheckSummary {
  adjusted: number;
  matched: number;
  not_counted: number;
}

export async function finishStockCheck(check: string): Promise<ActionResult<CheckSummary>> {
  return run('finish_stock_check', async (tx) => {
    const r = await sql<{ s: CheckSummary }>`
      select inv.finish_stock_check(${check}::uuid) as s`.execute(tx);
    return r.rows[0]!.s;
  });
}

/**
 * A presigned POST for one proof photo at `node`. Access is decided in SQL
 * (core.can(STOCK_CHECK, modify), rule 2); the key embeds the tenant and the store, and
 * inv.record_check_line accepts only keys under that prefix.
 */
export async function getCheckUploadUrl(
  node: string,
  contentType: string,
  size: number,
): Promise<ActionResult<UploadTarget>> {
  if (!photosEnabled()) return { ok: false, code: 'INVALID_PHOTO', message: 'Photos are off.' };
  if (!isPhotoType(contentType) || size < 1 || size > MAX_PHOTO_BYTES) {
    return failure(new Error('INVALID_PHOTO'));
  }
  const user = await requireUser();
  try {
    const tenant = await withUser(user.id, async (tx) => {
      const r = await sql<{ ok: boolean; tenant: string | null }>`
        select core.can('STOCK_CHECK', 'modify', null, ${node}::uuid) as ok,
               core.my_tenant() as tenant`.execute(tx);
      if (!r.rows[0]?.ok || !r.rows[0].tenant) throw new Error('NOT_AUTHORISED');
      return r.rows[0].tenant;
    });
    return { ok: true, data: await presignPhotoUpload('stockcheck', tenant, node, contentType) };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('presign check upload failed', err);
    return f;
  }
}
