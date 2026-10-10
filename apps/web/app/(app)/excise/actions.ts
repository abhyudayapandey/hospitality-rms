'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { requireModule } from '@/lib/modules-server';

// Excise (ADR 096): inv.add_excise_permit checks EXCISE modify at the store (rule 2).
export async function addPermit(
  store: string,
  permitNo: string,
  receivedOn: string,
  note: string,
): Promise<ActionResult<null>> {
  const user = await requireUser();
  try {
    await withUser(user.id, async (tx) => {
      await requireModule(tx, 'excise');
      await sql`select inv.add_excise_permit(${store}::uuid, ${permitNo}, ${receivedOn}::date,
                                             ${note})`.execute(tx);
    });
    revalidatePath('/excise');
    return { ok: true, data: null };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('add_excise_permit failed', err);
    return f;
  }
}
