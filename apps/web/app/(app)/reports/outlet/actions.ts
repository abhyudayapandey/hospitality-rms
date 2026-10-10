'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { requireModule } from '@/lib/modules-server';

// Covers (ADR 096): ops.set_covers checks that the person opens the outlet's day (rule 2).
export async function setCovers(
  outlet: string,
  day: string,
  period: string,
  covers: number,
): Promise<ActionResult<null>> {
  const user = await requireUser();
  try {
    await withUser(user.id, async (tx) => {
      await requireModule(tx, 'menu_sales');
      await sql`select ops.set_covers(${outlet}::uuid, ${day}::date, ${period}, ${covers}::int)`.execute(
        tx,
      );
    });
    revalidatePath('/reports/outlet');
    return { ok: true, data: null };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error('set_covers failed', err);
    return f;
  }
}
