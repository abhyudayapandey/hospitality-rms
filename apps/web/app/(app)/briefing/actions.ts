'use server';

import { revalidatePath } from 'next/cache';
import { failure, type ActionResult } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser, type Tx } from '@/lib/db';
import type { BriefingPart } from '@/lib/briefing';

// Today's briefing note (ADR 070). Each write is one ops.* SECURITY DEFINER function, which
// checks BRIEFING modify at the place and raises stable codes (rule 2).

async function run<T>(label: string, fn: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await withUser(user.id, fn);
    revalidatePath('/');
    revalidatePath('/briefing');
    return { ok: true, data };
  } catch (err) {
    const f = failure(err);
    if (f.code === 'UNEXPECTED') console.error(`${label} failed`, err);
    return f;
  }
}

export async function saveBriefing(input: {
  place: string;
  part: BriefingPart;
  body: string;
  offDishes: string[];
  idempotencyKey: string;
  /** today or tomorrow (ADR 112) */
  day: string;
}): Promise<ActionResult<{ id: string }>> {
  return run('save_briefing', async (tx) => {
    const r = await sql<{ id: string }>`
      select ops.save_briefing(${input.place}::uuid, ${input.part}, ${input.body},
                               ${input.offDishes}::uuid[], ${input.idempotencyKey},
                               ${input.day}::date) as id`.execute(tx);
    return { id: r.rows[0]!.id };
  });
}

export async function takeDownBriefing(id: string): Promise<ActionResult<null>> {
  return run('take_down_briefing', async (tx) => {
    await sql`select ops.take_down_briefing(${id}::uuid)`.execute(tx);
    return null;
  });
}
