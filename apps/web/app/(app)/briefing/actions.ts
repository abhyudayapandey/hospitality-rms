'use server';

import { type ActionResult } from '@outlet-ops/domain';
import { sql, type Tx } from '@/lib/db';
import { runAction } from '@/lib/run-action';
import type { BriefingPart } from '@/lib/briefing';

// Today's briefing note (ADR 070). Each write is one ops.* SECURITY DEFINER function, which
// checks BRIEFING modify at the place and raises stable codes (rule 2).

const run = <T>(label: string, fn: (tx: Tx) => Promise<T>) =>
  runAction(label, fn, { revalidate: ['/', '/briefing'] });

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
