'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';

// The rooms' minibars (ADR 072). Each write is one ops.* SECURITY DEFINER function, which
// checks MINIBAR modify at the room's outlet and raises stable codes (rule 2).

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, fn);
    revalidatePath('/minibar');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

export async function checkMinibar(input: {
  room: string;
  lines: { item_id: string; left: number }[];
  idempotencyKey: string;
}): Promise<ActionResult<{ id: string }>> {
  return run('check_minibar', async (tx) => {
    const r = await sql<{ id: string }>`
      select ops.check_minibar(${input.room}::uuid, ${JSON.stringify(input.lines)}::jsonb,
                               ${input.idempotencyKey}) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function markMinibarCharged(id: string): Promise<ActionResult<null>> {
  return run('mark_minibar_charged', async (tx) => {
    await sql`select ops.mark_minibar_charged(${id}::uuid)`.execute(tx);
    return null;
  });
}
