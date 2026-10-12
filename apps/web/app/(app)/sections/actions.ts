'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';

/** Give a person exactly these sections for a day (ADR 133); the database checks who may. */
export async function giveSections(
  department: string,
  day: string,
  person: string,
  sectionIds: string[],
): Promise<ActionResult<number>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, async (tx) => {
      const r = await sql<{ n: number }>`
        select ops.give_sections(${department}::uuid, ${day}::date, ${person}::uuid,
                                 ${sectionIds}::uuid[]) as n`.execute(tx);
      return r.rows[0]!.n;
    });
    revalidatePath('/sections/give');
    revalidatePath('/');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('give_sections failed', err);
    return f;
  }
}
