'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { breakageItems, type BreakageItem } from '@/lib/breakage';
import { requireModule } from '@/lib/modules-server';
import { isPhotoType, MAX_PHOTO_BYTES, type UploadTarget } from '@/lib/photo-policy';
import { photosEnabled, presignWastageUpload } from '@/lib/photos';

// Breakage (ADR 093): inv.record_breakage checks who may, the store and the stock (rule 2).

export async function recordBreakage(input: {
  place: string;
  store: string;
  item: string;
  qty: number;
  reason: string;
  brokenBy: string;
  person: string | null;
  note: string;
  /** the photo of what broke, from the live camera (ADR 143) */
  photoKey: string | null;
  idempotencyKey: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, async (tx) => {
      await requireModule(tx, 'breakage');
      const r = await sql<{ id: string }>`
        select inv.record_breakage(${input.place}::uuid, ${input.store}::uuid,
                                   ${input.item}::uuid, ${input.qty}, ${input.reason},
                                   ${input.brokenBy}, ${input.person}::uuid, ${input.note},
                                   ${input.idempotencyKey}, ${input.photoKey}) as id`.execute(tx);
      return { id: r.rows[0]!.id };
    });
    revalidatePath('/breakage');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('record_breakage failed', err);
    return f;
  }
}

/** What a store has that may be recorded broken, for the form when the store changes. */
export async function itemsAt(store: string): Promise<ActionResult<BreakageItem[]>> {
  const user = await requireUser();
  try {
    return { ok: true, data: await withUser(user.id, (tx) => breakageItems(tx, store)) };
  } catch (err) {
    return failure(err);
  }
}

/** Presigns the photo of what broke, at the store it came from (ADR 143), stored like wastage. */
export async function getBreakageUploadUrl(
  store: string,
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
      await requireModule(tx, 'breakage');
      // inv.breakage_items refuses anyone who may not record breakage from this store
      const r = await sql<{ tenant: string | null }>`
        select core.my_tenant() as tenant
          from (select count(*) from inv.breakage_items(${store}::uuid)) x`.execute(tx);
      if (!r.rows[0]?.tenant) throw new Error('NOT_AUTHORISED');
      return r.rows[0].tenant;
    });
    return { ok: true, data: await presignWastageUpload(tenant, store, contentType) };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('presign breakage photo failed', err);
    return f;
  }
}
