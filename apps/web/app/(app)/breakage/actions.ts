'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { breakageItems, type BreakageItem } from '@/lib/breakage';
import { requireModule } from '@/lib/modules-server';

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
                                   ${input.idempotencyKey}) as id`.execute(tx);
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
