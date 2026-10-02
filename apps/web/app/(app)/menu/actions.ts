'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
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
