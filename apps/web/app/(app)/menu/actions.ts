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
import { requireModule } from '@/lib/modules-server';

// Menu and recipe edits (ADR 014). Each calls one SECURITY DEFINER function that checks
// MENU modify at every store the recipe or price is used at; a change is a new version from
// its date, and every row change is in the audit log.

export interface RecipeLineInput {
  ingredient_item_id: string;
  qty: number;
  unit: string;
  trim_loss_pct: number;
}

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, fn);
    revalidatePath('/menu', 'layout');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

export async function saveRecipe(
  kind: 'prep' | 'menu',
  subjectId: string,
  lines: RecipeLineInput[],
  effectiveFrom: string,
  batchYield: number | null,
): Promise<ActionResult<{ id: string }>> {
  return run('save_recipe', async (tx) => {
    const r = await sql<{ id: string }>`
      select inv.save_recipe(${kind}, ${subjectId}::uuid, ${JSON.stringify(lines)}::jsonb,
                             ${effectiveFrom}::date, ${batchYield}::numeric) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function setPrice(
  menuItemId: string,
  outletId: string,
  price: number,
  effectiveFrom: string,
): Promise<ActionResult<{ id: string }>> {
  return run('set_price', async (tx) => {
    await requireModule(tx, 'menu_sales');
    const r = await sql<{ id: string }>`
      select menu.set_price(${menuItemId}::uuid, ${outletId}::uuid, ${price}::numeric,
                            ${effectiveFrom}::date) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

/** A day's sales at an outlet (ADR 015): the day's totals per item; changes deplete stock. */
export async function postSales(
  outletId: string,
  date: string,
  lines: { menu_item_id: string; qty: number }[],
  idempotencyKey: string,
): Promise<ActionResult<{ id: string }>> {
  return run('post_sales', async (tx) => {
    await requireModule(tx, 'menu_sales');
    const r = await sql<{ id: string }>`
      select menu.post_sales(${outletId}::uuid, ${date}::date, ${JSON.stringify(lines)}::jsonb,
                             'manual', ${idempotencyKey}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export interface PosLineInput {
  code: string;
  description: string;
  qty: number;
  value: number;
  discount: number;
}

export interface PosResult {
  import_id: string;
  posted: number;
  unmatched: { code: string; description: string; qty: number; value: number }[];
  net: number;
  discount: number;
}

/**
 * A day's POS file (SAL-2, ADR 039), read in the browser with the same reader the tests
 * use; the database checks it all again (dates, totals, quantities, who may import).
 */
export async function importPos(
  outletId: string,
  date: string,
  file: {
    fileName: string;
    posOutlets: string[];
    periodFrom: string | null;
    periodTo: string | null;
    totalValue: number;
    lines: PosLineInput[];
  },
  idempotencyKey: string,
): Promise<ActionResult<PosResult>> {
  return run('import_pos', async (tx) => {
    await requireModule(tx, 'menu_sales');
    const body = {
      file_name: file.fileName.slice(0, 200),
      pos_outlets: file.posOutlets,
      period_from: file.periodFrom,
      period_to: file.periodTo,
      total_value: file.totalValue,
      lines: file.lines,
    };
    const r = await sql<{ r: PosResult }>`
      select menu.import_pos(${outletId}::uuid, ${date}::date, ${JSON.stringify(body)}::jsonb,
                             ${idempotencyKey}) as r`.execute(tx);
    return r.rows[0]!.r;
  });
}

/** Matches a POS code to a menu item on the outlet's menu (people who post its sales). */
export async function mapPosItem(
  outletId: string,
  code: string,
  menuItemId: string,
): Promise<ActionResult<null>> {
  return run('map_pos_item', async (tx) => {
    await sql`select menu.map_pos_item(${outletId}::uuid, ${code}, ${menuItemId}::uuid)`.execute(
      tx,
    );
    return null;
  });
}

/** Posts an import again, once its codes are matched. */
export async function repostPos(importId: string): Promise<ActionResult<PosResult>> {
  return run('repost_pos', async (tx) => {
    const r = await sql<{ r: PosResult }>`select menu.repost_pos(${importId}::uuid) as r`.execute(
      tx,
    );
    return r.rows[0]!.r;
  });
}

// --- a dish's photo (ADR 078) ------------------------------------------------------------

/**
 * One presigned POST for a dish's photo, after menu.can_edit_dish() says the caller may
 * change the dish (rule 2). The key is items/<tenant>/<dish>/<uuid>, the only shape
 * menu.set_dish_photo accepts.
 */
export async function getDishUploadUrl(
  dish: string,
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
        select menu.can_edit_dish(${dish}::uuid) as ok, core.my_tenant() as tenant`.execute(tx);
      if (!r.rows[0]?.ok || !r.rows[0].tenant) throw new Error('NOT_AUTHORISED');
      return r.rows[0].tenant;
    });
    return { ok: true, data: await presignPhotoUpload('items', tenant, dish, contentType) };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('dish photo presign failed', err);
    return f;
  }
}

/** Sets (or with null clears) the dish's photo; menu.set_dish_photo checks who and the key. */
export async function setDishPhoto(
  dish: string,
  photoKey: string | null,
): Promise<ActionResult<null>> {
  return run('set_dish_photo', async (tx) => {
    await sql`select menu.set_dish_photo(${dish}::uuid, ${photoKey})`.execute(tx);
    return null;
  });
}
